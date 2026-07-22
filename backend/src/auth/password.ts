import bcrypt from "bcryptjs";
import { env } from "../config/env";

export function verifyPassword(candidate: string): boolean {
  if (!env.adminPasswordHash) {
    throw new Error(
      "ADMIN_PASSWORD_HASH is not set. Generate one with: node -e \"console.log(require('bcryptjs').hashSync('yourpassword', 10))\""
    );
  }
  return bcrypt.compareSync(candidate, env.adminPasswordHash);
}
