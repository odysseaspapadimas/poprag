/**
 * Firebase Firestore REST API client for Cloudflare Workers
 *
 * Firebase Admin SDK doesn't work in edge runtimes (Cloudflare Workers),
 * so we use the Firestore REST API instead.
 *
 * Uses service account credentials to generate access tokens for authentication.
 */

interface FirestoreDocument {
  name: string;
  fields: Record<string, any>;
  createTime: string;
  updateTime: string;
}

interface FirestoreListResponse {
  documents?: FirestoreDocument[];
  nextPageToken?: string;
}

interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
}

let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Get service account from environment
 */
function getServiceAccount(): ServiceAccount {
  const decoded = Buffer.from(
    process.env.SERVICE_ACCOUNT_DATA!,
    "base64",
  ).toString("utf-8");
  return JSON.parse(decoded);
}

/**
 * Generate JWT for Google OAuth
 */
async function generateJWT(serviceAccount: ServiceAccount): Promise<string> {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  // Import crypto dynamically to work in edge runtime
  const { subtle } = globalThis.crypto;

  // Convert PEM private key to CryptoKey
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = serviceAccount.private_key
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");

  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const key = await subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Create JWT
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "");
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "");
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signature = await subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  const encodedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${unsignedToken}.${encodedSignature}`;
}

/**
 * Get access token for Firestore REST API
 */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid
  if (cachedAccessToken && Date.now() < tokenExpiry) {
    return cachedAccessToken;
  }

  const serviceAccount = getServiceAccount();
  const jwt = await generateJWT(serviceAccount);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedAccessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Refresh 1 min early

  return cachedAccessToken!;
}

/**
 * Firestore REST API client
 */
export async function getFirebaseAdmin() {
  const serviceAccount = getServiceAccount();
  const projectId = serviceAccount.project_id;
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  return {
    collection: (collectionName: string) => ({
      async get() {
        const token = await getAccessToken();
        const response = await fetch(`${baseUrl}/${collectionName}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Firestore API error: ${response.statusText}`);
        }

        const data: FirestoreListResponse = await response.json();

        return {
          size: data.documents?.length || 0,
          docs: (data.documents || []).map((doc) => ({
            id: doc.name.split("/").pop() || "",
            data: () => transformFirestoreFields(doc.fields),
          })),
          forEach: (callback: (doc: any) => void) => {
            (data.documents || []).forEach((doc) => {
              callback({
                id: doc.name.split("/").pop() || "",
                data: () => transformFirestoreFields(doc.fields),
              });
            });
          },
        };
      },

      doc: (docId: string) => ({
        async get() {
          const token = await getAccessToken();
          const response = await fetch(
            `${baseUrl}/${collectionName}/${docId}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          );

          if (!response.ok) {
            if (response.status === 404) {
              return { exists: false, id: docId, data: () => null };
            }
            throw new Error(`Firestore API error: ${response.statusText}`);
          }

          const doc: FirestoreDocument = await response.json();
          return {
            exists: true,
            id: docId,
            data: () => transformFirestoreFields(doc.fields),
          };
        },

        async set(data: any) {
          const token = await getAccessToken();
          const fields = transformToFirestoreFields(data);

          const response = await fetch(
            `${baseUrl}/${collectionName}/${docId}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ fields }),
            },
          );

          if (!response.ok) {
            throw new Error(`Firestore API error: ${response.statusText}`);
          }

          return await response.json();
        },

        async delete() {
          const token = await getAccessToken();
          const response = await fetch(
            `${baseUrl}/${collectionName}/${docId}`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          );

          if (!response.ok) {
            throw new Error(`Firestore API error: ${response.statusText}`);
          }
        },
      }),
    }),
  };
}

/**
 * Transform Firestore REST API fields to plain objects
 */
function transformFirestoreFields(fields: Record<string, any>): any {
  const result: any = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value.stringValue !== undefined) {
      result[key] = value.stringValue;
    } else if (value.integerValue !== undefined) {
      result[key] = parseInt(value.integerValue, 10);
    } else if (value.doubleValue !== undefined) {
      result[key] = value.doubleValue;
    } else if (value.booleanValue !== undefined) {
      result[key] = value.booleanValue;
    } else if (value.timestampValue !== undefined) {
      const date = new Date(value.timestampValue);
      result[key] = {
        _seconds: Math.floor(date.getTime() / 1000),
        _nanoseconds: (date.getTime() % 1000) * 1000000,
      };
    } else if (value.mapValue) {
      result[key] = transformFirestoreFields(value.mapValue.fields || {});
    } else if (value.arrayValue) {
      result[key] = (value.arrayValue.values || []).map(
        (v: any) => transformFirestoreFields({ value: v }).value,
      );
    } else if (value.nullValue !== undefined) {
      result[key] = null;
    }
  }

  return result;
}

/**
 * Transform plain objects to Firestore REST API fields
 */
function transformToFirestoreFields(obj: any): Record<string, any> {
  const fields: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === null) {
      fields[key] = { nullValue: null };
    } else if (typeof value === "string") {
      fields[key] = { stringValue: value };
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        fields[key] = { integerValue: value.toString() };
      } else {
        fields[key] = { doubleValue: value };
      }
    } else if (typeof value === "boolean") {
      fields[key] = { booleanValue: value };
    } else if (value instanceof Date) {
      fields[key] = { timestampValue: value.toISOString() };
    } else if (
      typeof value === "object" &&
      value !== null &&
      "_seconds" in value &&
      typeof value._seconds === "number"
    ) {
      // Handle Firebase timestamp objects
      const date = new Date(value._seconds * 1000);
      fields[key] = { timestampValue: date.toISOString() };
    } else if (Array.isArray(value)) {
      fields[key] = {
        arrayValue: {
          values: value.map((v) => {
            const transformed = transformToFirestoreFields({ value: v });
            return transformed.value;
          }),
        },
      };
    } else if (typeof value === "object") {
      fields[key] = {
        mapValue: { fields: transformToFirestoreFields(value) },
      };
    }
  }

  return fields;
}
