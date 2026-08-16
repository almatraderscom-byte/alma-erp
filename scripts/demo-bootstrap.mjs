/**
 * demo-bootstrap.mjs — make a demo database ready for `prisma db push`.
 *
 * Idempotent and non-destructive: it only creates the Postgres extensions the
 * schema depends on. Five models declare `Unsupported("vector(1536)")`, so a push
 * against a database without pgvector fails on an unknown type.
 *
 * Why `db push` and not `prisma migrate deploy`: the migration chain is not
 * self-sufficient. Its first migration (`20260518154100_add_alma_trading`) adds a
 * foreign key to "User", and no migration in the repo ever creates that table —
 * production's schema predates the migration system. Against an empty database the
 * chain dies on migration 1, so a fresh demo database is built from schema.prisma
 * directly.
 *
 *   DATABASE_URL=<demo-db> node scripts/demo-bootstrap.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const statements = [
  'CREATE EXTENSION IF NOT EXISTS vector',
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
]

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql)
    console.log('ok:', sql)
  }
} finally {
  await prisma.$disconnect()
}
