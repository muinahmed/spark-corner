import { Database } from "@db/sqlite";

const dataDir = Deno.env.get("DATA_DIR") || "./database";
await Deno.mkdir(dataDir, { recursive: true });

const sqlite = new Database(`${dataDir}/shop.sqlite`);

sqlite.exec("PRAGMA foreign_keys = ON");

const db = {
  exec(sql) {
    return sqlite.exec(sql);
  },

  query(sql, params = []) {
    return sqlite.prepare(sql).values(...params);
  },

  lastInsertRowId() {
    return sqlite.lastInsertRowId();
  },

  close() {
    return sqlite.close();
  }
};

const schema = [
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    price REAL NOT NULL DEFAULT 0,
    sku TEXT,
    skin_concern TEXT,
    ingredients TEXT,
    how_to_use TEXT,
    material TEXT,
    size_info TEXT,
    care_instructions TEXT,
    stock INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    is_main INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    variant_name TEXT NOT NULL,
    variant_value TEXT NOT NULL,
    image_path TEXT,
    stock INTEGER,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    address TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    delivery_area TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    delivery_charge REAL NOT NULL DEFAULT 0,
    order_notes TEXT,
    total REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
  )`
];

for (const statement of schema) {
  db.exec(statement);
}

function addColumnIfMissing(table, column, definition) {
  const columns = db.query(`PRAGMA table_info(${table})`).map(row => row[1]);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

addColumnIfMissing("product_variants", "image_path", "image_path TEXT");
addColumnIfMissing("product_variants", "stock", "stock INTEGER");
addColumnIfMissing("orders", "delivery_area", "delivery_area TEXT");
addColumnIfMissing("orders", "subtotal", "subtotal REAL NOT NULL DEFAULT 0");
addColumnIfMissing("orders", "delivery_charge", "delivery_charge REAL NOT NULL DEFAULT 0");
addColumnIfMissing("orders", "order_notes", "order_notes TEXT");
addColumnIfMissing("products", "skin_concern", "skin_concern TEXT");
addColumnIfMissing("products", "ingredients", "ingredients TEXT");
addColumnIfMissing("products", "how_to_use", "how_to_use TEXT");
addColumnIfMissing("products", "material", "material TEXT");
addColumnIfMissing("products", "size_info", "size_info TEXT");
addColumnIfMissing("products", "care_instructions", "care_instructions TEXT");

export default db;
