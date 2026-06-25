export function isStagingAuthEnabled(): boolean {
  return process.env.AUTH_ENABLE_SIGN_UP === "true";
}

export function shouldAutoAdminSignUps(): boolean {
  return process.env.AUTH_AUTO_ADMIN_SIGN_UP === "true";
}
