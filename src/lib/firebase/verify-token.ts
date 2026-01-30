/**
 * Firebase ID Token Verification for Cloudflare Workers
 *
 * Verifies Firebase ID tokens using Google's public keys.
 * Works in edge runtime (no Firebase Admin SDK required).
 */

interface FirebaseTokenPayload {
  iss: string; // Issuer: https://securetoken.google.com/<project-id>
  aud: string; // Audience: <project-id>
  auth_time: number; // Time of authentication
  user_id: string; // Firebase UID
  sub: string; // Subject (same as user_id)
  iat: number; // Issued at
  exp: number; // Expiration
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  firebase: {
    identities: Record<string, string[]>;
    sign_in_provider: string;
  };
}

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  signInProvider: string;
}

interface GooglePublicKeys {
  [kid: string]: string;
}

// Cache for Google's public keys
let cachedKeys: GooglePublicKeys | null = null;
let keysCacheExpiry = 0;

/**
 * Fetch Google's public keys for verifying Firebase tokens
 */
async function getGooglePublicKeys(): Promise<GooglePublicKeys> {
  // Return cached keys if still valid
  if (cachedKeys && Date.now() < keysCacheExpiry) {
    return cachedKeys;
  }

  const response = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Google public keys: ${response.status}`);
  }

  // Parse cache-control header to determine expiry
  const cacheControl = response.headers.get("cache-control");
  let maxAge = 3600; // Default 1 hour
  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\d+)/);
    if (match) {
      maxAge = parseInt(match[1], 10);
    }
  }

  cachedKeys = (await response.json()) as GooglePublicKeys;
  keysCacheExpiry = Date.now() + maxAge * 1000;

  return cachedKeys;
}

/**
 * Base64URL decode
 */
function base64UrlDecode(str: string): string {
  // Add padding if needed
  const padding = "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + padding;
  return atob(base64);
}

/**
 * Convert PEM certificate to CryptoKey
 */
async function importPublicKey(pem: string): Promise<CryptoKey> {
  // Extract the base64 content from PEM
  const pemHeader = "-----BEGIN CERTIFICATE-----";
  const pemFooter = "-----END CERTIFICATE-----";
  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");

  // Decode base64 to binary
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  // Import as X.509 certificate and extract the public key
  // Note: Web Crypto API doesn't directly support X.509 certificates,
  // so we use the SPKI format which is embedded in the certificate
  return await crypto.subtle.importKey(
    "spki",
    extractSpkiFromCert(binaryDer),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Extract SPKI (Subject Public Key Info) from X.509 certificate
 * This is a simplified extraction that works for RSA certificates
 */
function extractSpkiFromCert(certDer: Uint8Array): ArrayBuffer {
  // X.509 certificates have the public key in a specific location
  // For Google's certificates, we can find it by searching for the RSA OID
  // This is a simplified approach - in production you might want a full ASN.1 parser

  // Look for the bit string that contains the public key
  // The sequence pattern for RSA public key in X.509
  const offset = 0;
  const view = new DataView(certDer.buffer);

  // Find the SubjectPublicKeyInfo sequence
  // It starts after tbsCertificate which contains version, serialNumber, signature, issuer, validity, subject
  // For simplicity, we search for the RSA algorithm OID: 1.2.840.113549.1.1.1
  const rsaOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

  for (let i = 0; i < certDer.length - rsaOid.length; i++) {
    let found = true;
    for (let j = 0; j < rsaOid.length; j++) {
      if (certDer[i + j] !== rsaOid[j]) {
        found = false;
        break;
      }
    }
    if (found) {
      // Found RSA OID, backtrack to find the SEQUENCE that contains SubjectPublicKeyInfo
      // The structure is: SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING }
      // We need to find the outer SEQUENCE

      // Search backwards for the SEQUENCE tag (0x30)
      let seqStart = i - 1;
      while (seqStart > 0 && certDer[seqStart] !== 0x30) {
        seqStart--;
      }

      // Go back one more level to get the full SubjectPublicKeyInfo
      seqStart--;
      while (seqStart > 0 && certDer[seqStart] !== 0x30) {
        seqStart--;
      }

      // Read the length
      let length: number;
      let lengthBytes: number;
      if (certDer[seqStart + 1] & 0x80) {
        lengthBytes = certDer[seqStart + 1] & 0x7f;
        length = 0;
        for (let k = 0; k < lengthBytes; k++) {
          length = (length << 8) | certDer[seqStart + 2 + k];
        }
        lengthBytes += 1; // Include the length-of-length byte
      } else {
        length = certDer[seqStart + 1];
        lengthBytes = 1;
      }

      // Extract SubjectPublicKeyInfo
      const spkiLength = 1 + lengthBytes + length;
      return certDer.slice(seqStart, seqStart + spkiLength).buffer;
    }
  }

  throw new Error("Could not extract public key from certificate");
}

/**
 * Verify a Firebase ID token
 *
 * @param idToken - The Firebase ID token to verify
 * @param projectId - Your Firebase project ID
 * @returns The verified user information, or null if invalid
 */
export async function verifyFirebaseToken(
  idToken: string,
  projectId: string,
): Promise<VerifiedFirebaseUser | null> {
  try {
    // Split the token
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      console.error("[Firebase Auth] Invalid token format");
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header to get key ID
    const header = JSON.parse(base64UrlDecode(headerB64)) as {
      alg: string;
      kid: string;
    };

    if (header.alg !== "RS256") {
      console.error("[Firebase Auth] Invalid algorithm:", header.alg);
      return null;
    }

    // Get Google's public keys
    const publicKeys = await getGooglePublicKeys();
    const publicKeyPem = publicKeys[header.kid];

    if (!publicKeyPem) {
      console.error("[Firebase Auth] Unknown key ID:", header.kid);
      return null;
    }

    // Import the public key
    const publicKey = await importPublicKey(publicKeyPem);

    // Verify the signature
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(base64UrlDecode(signatureB64), (c) =>
      c.charCodeAt(0),
    );

    const isValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      signedData,
    );

    if (!isValid) {
      console.error("[Firebase Auth] Invalid signature");
      return null;
    }

    // Decode and validate payload
    const payload = JSON.parse(
      base64UrlDecode(payloadB64),
    ) as FirebaseTokenPayload;

    // Validate claims
    const now = Math.floor(Date.now() / 1000);

    // Check expiration
    if (payload.exp < now) {
      console.error("[Firebase Auth] Token expired");
      return null;
    }

    // Check issued at (allow 5 minutes clock skew)
    if (payload.iat > now + 300) {
      console.error("[Firebase Auth] Token issued in the future");
      return null;
    }

    // Check audience
    if (payload.aud !== projectId) {
      console.error("[Firebase Auth] Invalid audience:", payload.aud);
      return null;
    }

    // Check issuer
    const expectedIssuer = `https://securetoken.google.com/${projectId}`;
    if (payload.iss !== expectedIssuer) {
      console.error("[Firebase Auth] Invalid issuer:", payload.iss);
      return null;
    }

    // Check subject
    if (!payload.sub || typeof payload.sub !== "string") {
      console.error("[Firebase Auth] Invalid subject");
      return null;
    }

    // Return verified user info
    return {
      uid: payload.sub,
      email: payload.email || null,
      emailVerified: payload.email_verified || false,
      displayName: payload.name || null,
      photoUrl: payload.picture || null,
      signInProvider: payload.firebase?.sign_in_provider || "unknown",
    };
  } catch (error) {
    console.error("[Firebase Auth] Token verification error:", error);
    return null;
  }
}

/**
 * Extract the Firebase ID token from an Authorization header
 *
 * @param authHeader - The Authorization header value (e.g., "Bearer <token>")
 * @returns The token, or null if not present/invalid format
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return null;
  }

  return parts[1];
}
