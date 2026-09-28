import bcrypt from "bcrypt";

const ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // Hash inválido/placeholder → nunca matchea.
    return false;
  }
}
