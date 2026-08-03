import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { PRODUCTS } from '../config/products.js'

const CREDENTIALS_PATH = new URL('../config/credentials.json', import.meta.url)

// Credentials live in config/credentials.json, which is gitignored and chmod 600.
// Keeping them here rather than sourcing each backend's env.sh means this project
// never depends on, or reaches into, the product repositories.
function loadCredentials (productKey) {
  let all
  try {
    all = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read config/credentials.json: ${err.message}`)
  }
  const c = all[productKey]
  if (!c) throw new Error(`config/credentials.json has no entry for '${productKey}'`)
  for (const field of ['host', 'user', 'password', 'database']) {
    if (!c[field]) throw new Error(`config/credentials.json: ${productKey}.${field} is empty`)
  }
  return c
}

// This project issues SELECT statements only — there is no write path anywhere in it.
// tarot points at a reader endpoint, so the engine rejects writes regardless. astro
// has no separate reader endpoint available, so there the read-only guarantee rests on
// the code alone.
export async function connect (productKey) {
  const product = PRODUCTS[productKey]
  if (!product) throw new Error(`unknown product: ${productKey}`)
  const c = loadCredentials(productKey)

  const pool = mysql.createPool({
    host: c.host,
    port: c.port || 3306,
    user: c.user,
    password: c.password,
    database: c.database,
    // Six per chunk in parallel, plus the next chunk prefetching underneath them.
    connectionLimit: 14,
    // Return DATETIME columns as raw strings. The driver would otherwise parse them
    // into Date objects using the local timezone, which silently shifts every
    // production timestamp by the machine's UTC offset.
    dateStrings: true
  })

  await pool.query('SELECT 1')
  return { pool, database: c.database, host: c.host, product }
}
