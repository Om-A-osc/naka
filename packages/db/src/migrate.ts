import { getDb } from "./sqlite.js";

// Running this file directly applies the schema.
const db = getDb();
console.log(`migrated ${process.env.NAKA_DB ?? "./data/naka.db"}`);
db.close();
