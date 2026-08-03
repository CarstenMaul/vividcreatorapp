import bcrypt from "bcrypt";

const COST = 12;
const MIN_LEN = 8;
const MAX_LEN = 256;

// A pre-hashed throwaway string. Used by verifyAgainstDummy() so that
// "username not found" takes roughly the same wall-clock time as
// "username found but wrong password" — making login-local timing-uniform.
let dummyHash = "";
function getDummyHash(): string {
  if (!dummyHash) dummyHash = bcrypt.hashSync("vca-dummy-password-not-real", COST);
  return dummyHash;
}

export function validatePassword(plain: unknown): string {
  if (typeof plain !== "string") throw passwordError("INVALID_PASSWORD", "password must be a string");
  if (plain.length < MIN_LEN) throw passwordError("INVALID_PASSWORD", `password must be at least ${MIN_LEN} characters`);
  if (plain.length > MAX_LEN) throw passwordError("INVALID_PASSWORD", `password must be at most ${MAX_LEN} characters`);
  return plain;
}

export async function hashPassword(plain: string): Promise<string> {
  validatePassword(plain);
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (typeof plain !== "string" || typeof hash !== "string" || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

// Burn the bcrypt cost against a dummy hash so the "user not found" branch
// has comparable timing to a real check. Always resolves false.
export async function verifyAgainstDummy(plain: string): Promise<false> {
  try {
    await bcrypt.compare(typeof plain === "string" ? plain : "", getDummyHash());
  } catch { /* ignore */ }
  return false;
}

interface PasswordError extends Error {
  code: string;
}

function passwordError(code: string, message: string): PasswordError {
  const e = new Error(message) as PasswordError;
  e.code = code;
  return e;
}
