import "dotenv/config";
import bcrypt from "bcrypt";
import { prisma } from "../src/lib/prisma";

// One-off script to create the very first ADMIN account. Run manually
// (npm run seed:admin, from backend/) whenever a fresh environment needs
// its initial admin - there is no public API route that can create an
// AdminUser with role ADMIN from nothing; every AdminUser after this one
// is created via POST /api/admin/staff by an existing ADMIN.
const BCRYPT_ROUNDS = 12;

async function main() {
  const username = process.env.SEED_ADMIN_USERNAME?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD must both be set in the environment",
    );
  }

  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    throw new Error(
      `An AdminUser with username "${username}" already exists (id ${existing.id}) - refusing to overwrite it. Deactivate or rename it first if you really mean to replace it.`,
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const admin = await prisma.adminUser.create({
    data: { username, passwordHash, role: "ADMIN" },
  });

  console.log(`Created ADMIN account "${admin.username}" (id ${admin.id}).`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
