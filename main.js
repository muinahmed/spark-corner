import db from "./database/database.js";

const PORT = 8000;
const carts = new Map();
const sessions = new Map();

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "muin123";

const ORDER_STATUSES = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered"];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function page(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Spark Corner</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
${content}
</body>
</html>`;
}

function redirect(location) {
  return new Response(null, {
    status: 303,
    headers: { Location: location }
  });
}

function cookie(request, name) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...values] = part.trim().split("=");
    if (key === name) return decodeURIComponent(values.join("="));
  }
  return null;
}

function cartIdFor(request) {
  return cookie(request, "spark_cart");
}

function getCart(request) {
  const id = cartIdFor(request);
  if (!id) return [];
  return carts.get(id) ?? [];
}

function ensureCart(request) {
  let id = cartIdFor(request);
  if (!id) id = crypto.randomUUID();
  if (!carts.has(id)) carts.set(id, []);
  return id;
}

function cartResponse(request, response) {
  const existing = cartIdFor(request);
  if (existing) return response;
  const id = ensureCart(request);
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `spark_cart=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax`
  );
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function isAdmin(request) {
  const token = cookie(request, "spark_admin");
  return Boolean(token && sessions.has(token));
}

function adminGuard(request) {
  if (!isAdmin(request)) return redirect("/admin/login");
  return null;
}

function layoutHeader(active = "") {
  return `
<header class="site-header">
  <div class="container nav">
    <a class="brand" href="/">
  <img src="/images/logo.jpg" alt="Spark Corner">
</a>
    <nav>
      <a class="${active === "shop" ? "active" : ""}" href="/products">Shop</a>
      <a href="/#about">About</a>
      <a href="/#contact">Contact</a>
      <a class="cart-link" href="/cart">Cart</a>
    </nav>
  </div>
</header>`;
}

function adminHeader(title) {
  return `
<header class="admin-header">
  <div>
    <a class="brand" href="/admin/dashboard">Spark <span>Corner</span></a>
    <strong>${escapeHtml(title)}</strong>
  </div>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/products">Products</a>
    <a href="/admin/categories">Categories</a>
    <a href="/admin/orders">Orders</a>
    <form method="POST" action="/admin/logout"><button class="link-button">Logout</button></form>
  </nav>
</header>`;
}

function adminPage(title, content) {
  return page(title, `${adminHeader(title)}<main class="admin-main">${content}</main>`);
}

function getProducts(search = "", category = "", limit = 24, offset = 0) {
  return db.query(`
    SELECT p.id, p.category_id, p.name, p.slug, p.description,
           p.price, p.sku, p.stock, p.is_active,
           c.name AS category_name,
           COALESCE(
             (SELECT image_path FROM product_images
              WHERE product_id = p.id AND is_main = 1 LIMIT 1), ''
           ) AS image_path
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY p.id DESC
    LIMIT ? OFFSET ?
  `, [limit, offset]);
}

function getProduct(id) {
  const rows = db.query(`
    SELECT p.id, p.category_id, p.name, p.slug, p.description,
           p.price, p.sku, p.stock, p.is_active,
           c.name AS category_name,
           COALESCE(
             (SELECT image_path FROM product_images
              WHERE product_id = p.id AND is_main = 1 LIMIT 1), ''
           ) AS image_path
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.id = ?
  `, [id]);

  if (!rows.length) return null;

  const row = rows[0];
  const variants = db.query(`
    SELECT id, variant_name, variant_value
    FROM product_variants
    WHERE product_id = ?
    ORDER BY id
  `, [id]);

  const images = db.query(`
  SELECT image_path, is_main
  FROM product_images
  WHERE product_id = ?
  ORDER BY is_main DESC, id ASC
`, [id]);

  return {
    id: row[0],
    categoryId: row[1],
    name: row[2],
    slug: row[3],
    description: row[4] ?? "",
    price: Number(row[5]),
    sku: row[6] ?? "",
    stock: Number(row[7]),
    active: Number(row[8]) === 1,
    categoryName: row[9] ?? "Uncategorised",
    imagePath: row[10] ?? "",
    images: images.map(image => ({
  path: image[0],
  isMain: Number(image[1]) === 1
})),
    variants: variants.map(v => ({
      id: v[0],
      name: v[1],
      value: v[2]
    }))
  };
}

function getCartDetails(request) {
  return getCart(request).map(item => {
    const product = getProduct(item.productId);
    if (!product) return null;
    return {
      ...item,
      product,
      lineTotal: product.price * item.quantity
    };
  }).filter(Boolean);
}

function totalForCart(details) {
  return details.reduce((sum, item) => sum + item.lineTotal, 0);
}

function imageMime(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function readView(name) {
  return await Deno.readTextFile(`./views/${name}`);
}

async function saveUploadedImage(file) {
  if (!(file instanceof File) || file.size === 0) return null;

  if (!file.type.startsWith("image/")) {
    throw new Error("Please upload an image file.");
  }

  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Image must be 5 MB or smaller.");
  }

  const originalExtension = file.name.includes(".")
    ? file.name.split(".").pop().toLowerCase()
    : "jpg";

  const allowed = ["jpg", "jpeg", "png", "webp", "gif"];
  const extension = allowed.includes(originalExtension) ? originalExtension : "jpg";
  const fileName = `${crypto.randomUUID()}.${extension}`;
  const diskPath = `./public/uploads/products/${fileName}`;
const webPath = `/uploads/products/${fileName}`;

await Deno.mkdir("./public/uploads/products", { recursive: true });

await Deno.writeFile(
  diskPath,
  new Uint8Array(await file.arrayBuffer())
);

  return { diskPath, webPath };
}

function categoryOptions(selectedId = null) {
  const rows = db.query("SELECT id, name FROM categories ORDER BY name");
  return rows.map(([id, name]) =>
    `<option value="${id}" ${Number(id) === Number(selectedId) ? "selected" : ""}>${escapeHtml(name)}</option>`
  ).join("");
}

function variantRows(variants = []) {
  if (!variants.length) {
    return `<tr><td><input name="variant_name" placeholder="e.g. Size"></td><td><input name="variant_value" placeholder="e.g. Medium"></td></tr>`;
  }

  return variants.map(v => `
    <tr>
      <td><input name="variant_name" value="${escapeHtml(v.name)}"></td>
      <td><input name="variant_value" value="${escapeHtml(v.value)}"></td>
    </tr>
  `).join("");
}

Deno.serve({ port: PORT }, async (request) => {
  const url = new URL(request.url);

  try {
    // ---------- Static files ----------
    if (url.pathname === "/css/style.css") {
      const css = await Deno.readTextFile("./public/css/style.css");
      return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
    }

    if (url.pathname.startsWith("/images/")) {
  const safePath = url.pathname.replaceAll("..", "");

  try {
    const data = await Deno.readFile(`./public${safePath}`);

    return new Response(data, {
      headers: {
        "content-type": "image/jpeg"
      }
    });
  } catch {
    return new Response("Image not found", { status: 404 });
  }
}

    if (url.pathname.startsWith("/uploads/products/")) {
      const safePath = url.pathname.replaceAll("..", "");
      try {
        const data = await Deno.readFile(`./public${safePath}`);
        return new Response(data, { headers: { "content-type": imageMime(safePath) } });
      } catch {
        return new Response("Image not found", { status: 404 });
      }
    }

    // ---------- Home ----------
    if (url.pathname === "/" && request.method === "GET") {
      const products = getProducts().filter(row => Number(row[8]) === 1).slice(0, 6);
      const cards = products.map(row => {
        const image = row[10]
          ? `<img src="${row[10]}" alt="${escapeHtml(row[2])}">`
          : `<div class="image-placeholder">Spark Corner</div>`;
        return `<article class="product-card">
          <a href="/product/${row[0]}">${image}</a>
          <div class="product-card-body">
            <p class="eyebrow">${escapeHtml(row[9] ?? "Collection")}</p>
            <h3>${escapeHtml(row[2])}</h3>
            <strong>৳${Number(row[5]).toFixed(0)}</strong>
            <a class="btn btn-small" href="/product/${row[0]}">View product</a>
          </div>
        </article>`;
      }).join("");

      const html = await readView("home.html");

return new Response(
  page("Home", html.replace("{{PRODUCTS}}", cards)),
  { headers: { "content-type": "text/html; charset=utf-8" } }
);
    }

    // ---------- Shop ----------

if (url.pathname === "/products" && request.method === "GET") {
  const search = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category") ?? "";

  let sql = `
    SELECT p.id, p.name, p.price, p.stock, p.is_active,
           c.name AS category_name,
           COALESCE((SELECT image_path FROM product_images
             WHERE product_id = p.id AND is_main = 1 LIMIT 1), '') AS image_path
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = 1
  `;
      const params = [];

      if (search) {
        sql += " AND (LOWER(p.name) LIKE LOWER(?) OR LOWER(p.description) LIKE LOWER(?))";
        params.push(`%${search}%`, `%${search}%`);
      }

      if (category) {
        sql += " AND c.slug = ?";
        params.push(category);
      }

      const pageNumber = Math.max(1, Number(url.searchParams.get("page") || 1));
const pageSize = 24;

sql += " ORDER BY p.id DESC LIMIT ? OFFSET ?";
params.push(pageSize, (pageNumber - 1) * pageSize);

const products = db.query(sql, params);
      const categories = db.query("SELECT name, slug FROM categories ORDER BY name");

      const categoryLinks = categories.map(([name, slug]) =>
        `<a href="/products?category=${encodeURIComponent(slug)}">${escapeHtml(name)}</a>`
      ).join("");

      const cards = products.map(row => {
        const image = row[6]
          ? `<img src="${row[6]}" alt="${escapeHtml(row[1])}">`
          : `<div class="image-placeholder">No image</div>`;

        return `<article class="product-card">
          <a href="/product/${row[0]}">${image}</a>
          <div class="product-card-body">
            <p class="eyebrow">${escapeHtml(row[5] ?? "Collection")}</p>
            <h3>${escapeHtml(row[1])}</h3>
            <strong>৳${Number(row[2]).toFixed(0)}</strong>
            <p class="${Number(row[3]) > 0 ? "stock" : "out"}">
              ${Number(row[3]) > 0 ? `${row[3]} available` : "Out of stock"}
            </p>
            <a class="btn btn-small" href="/product/${row[0]}">View product</a>
          </div>
        </article>`;
      }).join("") || `<div class="empty"><h2>No products found</h2><p>Try another search or category.</p></div>`;

      const queryBase = new URLSearchParams();

if (search) queryBase.set("q", search);
if (category) queryBase.set("category", category);

const pagination = `
  <div class="pagination">
    ${pageNumber > 1
      ? `<a href="/products?${queryBase.toString()}&page=${pageNumber - 1}">← Previous</a>`
      : ""}
    <span>Page ${pageNumber}</span>
    ${products.length === pageSize
      ? `<a href="/products?${queryBase.toString()}&page=${pageNumber + 1}">Next →</a>`
      : ""}
  </div>
`;

      const html = await readView("products.html");

return new Response(
  page(
    "Shop",
    html
      .replace("{{SEARCH}}", escapeHtml(search))
      .replace("{{CATEGORIES}}", categoryLinks)
      .replace("{{PRODUCTS}}", cards)
      .replace("{{PAGINATION}}", pagination)
  ),
  { headers: { "content-type": "text/html; charset=utf-8" } }
);
    }

    // ---------- Product details ----------
    if (url.pathname.startsWith("/product/") && request.method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      const product = getProduct(id);

      if (!product) return new Response("Product not found", { status: 404 });

      const variantSelector = product.variants.length
        ? `<label>Choose ${escapeHtml(product.variants[0].name)}
             <select name="variant" required>
               ${product.variants.map(v =>
                 `<option value="${escapeHtml(v.name + ": " + v.value)}">${escapeHtml(v.value)}</option>`
               ).join("")}
             </select>
           </label>`
        : "";

      const image = product.imagePath
        ? `<img src="${product.imagePath}" alt="${escapeHtml(product.name)}">`
        : `<div class="image-placeholder large">No image</div>`;

      const html = await readView("product.html");
      const imageGallery = product.images.map((img) => `
  <img
    src="${img.path}"
    alt="${escapeHtml(product.name)}"
    class="product-thumbnail"
  >
`).join("");

return new Response(
  page(
    "Product",
    html
      .replace("{{NAME}}", escapeHtml(product.name))
      .replace("{{CATEGORY}}", escapeHtml(product.categoryName))
      .replace("{{DESCRIPTION}}", escapeHtml(product.description))
      .replace("{{PRICE}}", product.price.toFixed(0))
      .replace("{{STOCK}}", String(product.stock))
      .replace("{{IMAGE}}", image)
      .replace("{{VARIANT}}", variantSelector)
      .replace("{{PRODUCT_ID}}", String(product.id))
      .replace("{{DISABLED}}", product.stock > 0 ? "" : "disabled")
      .replace("{{IMAGES}}", imageGallery)
      .replace(
        "{{STOCK_TEXT}}",
        product.stock > 0 ? `${product.stock} available` : "Out of stock"
      )
  ),
  {
    headers: { "content-type": "text/html; charset=utf-8" }
  }
);
    }
    // ---------- Cart add ----------
    if (url.pathname === "/cart/add" && request.method === "POST") {
      const form = await request.formData();
      const productId = Number(form.get("product_id"));
      const quantity = Number(form.get("quantity") || 1);
      const variant = form.get("variant")?.toString() || null;

      const product = getProduct(productId);
      if (!product) return new Response("Product not found", { status: 404 });
      if (quantity < 1 || quantity > product.stock) {
        return new Response("Invalid quantity or insufficient stock", { status: 400 });
      }

      const id = ensureCart(request);
      const cart = carts.get(id);
      const existing = cart.find(i => i.productId === productId && i.variant === variant);

      if (existing) {
        if (existing.quantity + quantity > product.stock) {
          return new Response("Not enough stock available", { status: 400 });
        }
        existing.quantity += quantity;
      } else {
        cart.push({ productId, quantity, variant });
      }

      carts.set(id, cart);
      return redirect("/cart");
    }

    // ---------- Cart ----------
    if (url.pathname === "/cart" && request.method === "GET") {
      const details = getCartDetails(request);
      const items = details.map(item => `
        <div class="cart-item">
          <div class="cart-image">
            ${item.product.imagePath
              ? `<img src="${item.product.imagePath}" alt="${escapeHtml(item.product.name)}">`
              : `<div class="image-placeholder">No image</div>`}
          </div>
          <div class="cart-info">
            <h2>${escapeHtml(item.product.name)}</h2>
            ${item.variant ? `<p class="variant">Variant: ${escapeHtml(item.variant)}</p>` : ""}
            <p class="price">৳${item.product.price.toFixed(0)}</p>
            <div class="cart-actions">
              <form method="POST" action="/cart/update">
                <input type="hidden" name="product_id" value="${item.product.id}">
                <input type="hidden" name="variant" value="${escapeHtml(item.variant ?? "")}">
                <input type="hidden" name="quantity" value="${Math.max(1, item.quantity - 1)}">
                <button type="submit" ${item.quantity <= 1 ? "disabled" : ""}>−</button>
              </form>
              <span>${item.quantity}</span>
              <form method="POST" action="/cart/update">
                <input type="hidden" name="product_id" value="${item.product.id}">
                <input type="hidden" name="variant" value="${escapeHtml(item.variant ?? "")}">
                <input type="hidden" name="quantity" value="${item.quantity + 1}">
                <button type="submit" ${item.quantity >= item.product.stock ? "disabled" : ""}>+</button>
              </form>
              <form method="POST" action="/cart/remove">
                <input type="hidden" name="product_id" value="${item.product.id}">
                <input type="hidden" name="variant" value="${escapeHtml(item.variant ?? "")}">
                <button class="danger-button" type="submit">Remove</button>
              </form>
            </div>
          </div>
          <strong>৳${item.lineTotal.toFixed(0)}</strong>
        </div>
      `).join("");

      const content = details.length
        ? `<div class="cart-layout">
             <section>${items}</section>
             <aside class="summary">
               <h2>Order summary</h2>
               <p><span>Subtotal</span><strong>৳${totalForCart(details).toFixed(0)}</strong></p>
               <a class="btn full" href="/checkout">Proceed to checkout</a>
             </aside>
           </div>`
        : `<div class="empty"><h2>Your cart is empty</h2><p>Add something you like from the shop.</p><a class="btn" href="/products">Shop now</a></div>`;

      return new Response(
        page("Cart", `${layoutHeader("shop")}<main class="container section"><div class="page-title"><p class="eyebrow">Your selection</p><h1>Shopping cart</h1></div>${content}</main>`),
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }

    if (url.pathname === "/cart/update" && request.method === "POST") {
      const form = await request.formData();
      const productId = Number(form.get("product_id"));
      const quantity = Number(form.get("quantity"));
      const variant = form.get("variant")?.toString() || null;
      const id = cartIdFor(request);
      const cart = id ? (carts.get(id) ?? []) : [];

      const item = cart.find(i => i.productId === productId && i.variant === variant);
      const product = getProduct(productId);

      if (!item || !product || quantity < 1 || quantity > product.stock) {
        return new Response("Invalid cart update", { status: 400 });
      }

      item.quantity = quantity;
      carts.set(id, cart);
      return redirect("/cart");
    }

    if (url.pathname === "/cart/remove" && request.method === "POST") {
      const form = await request.formData();
      const productId = Number(form.get("product_id"));
      const variant = form.get("variant")?.toString() || null;
      const id = cartIdFor(request);
      const cart = id ? (carts.get(id) ?? []) : [];

      carts.set(
        id,
        cart.filter(i => !(i.productId === productId && i.variant === variant))
      );
      return redirect("/cart");
    }

    // ---------- Checkout ----------
    if (url.pathname === "/checkout" && request.method === "GET") {
      const details = getCartDetails(request);
      if (!details.length) return redirect("/cart");

      const items = details.map(item => `
        <li>
          <span>
            ${escapeHtml(item.product.name)}
            ${item.variant ? ` <small>(${escapeHtml(item.variant)})</small>` : ""}
            × ${item.quantity}
          </span>
          <strong>৳${item.lineTotal.toFixed(0)}</strong>
        </li>
      `).join("");

      const html = await readView("checkout.html");

return new Response(
  page(
    "Checkout",
    html
      .replace("{{ITEMS}}", items)
      .replace("{{TOTAL}}", totalForCart(details).toFixed(0))
  ),
  { headers: { "content-type": "text/html; charset=utf-8" } }
);
    }

    if (url.pathname === "/checkout" && request.method === "POST") {
      const details = getCartDetails(request);
      if (!details.length) return redirect("/cart");

      const form = await request.formData();
      const name = form.get("customer_name")?.toString().trim();
      const phone = form.get("phone")?.toString().trim();
      const email = form.get("email")?.toString().trim() || null;
      const address = form.get("address")?.toString().trim();
      const payment = form.get("payment_method")?.toString();

      if (!name || !phone || !address || !["Cash on Delivery", "bKash", "Nagad"].includes(payment)) {
        return new Response("Please complete all required checkout fields.", { status: 400 });
      }

      for (const item of details) {
        const current = getProduct(item.product.id);
        if (!current || current.stock < item.quantity) {
          return new Response(`Not enough stock for ${escapeHtml(item.product.name)}.`, { status: 400 });
        }
      }

      const total = totalForCart(details);

      db.query(`
        INSERT INTO orders
        (customer_name, phone, email, address, payment_method, status, total)
        VALUES (?, ?, ?, ?, ?, 'Pending', ?)
      `, [name, phone, email, address, payment, total]);

      const orderId = db.query("SELECT last_insert_rowid()")[0][0];

      for (const item of details) {
        const displayName = item.variant
          ? `${item.product.name} (${item.variant})`
          : item.product.name;

        db.query(`
          INSERT INTO order_items
          (order_id, product_id, product_name, price, quantity)
          VALUES (?, ?, ?, ?, ?)
        `, [
          orderId,
          item.product.id,
          displayName,
          item.product.price,
          item.quantity
        ]);

        db.query(
          "UPDATE products SET stock = stock - ? WHERE id = ?",
          [item.quantity, item.product.id]
        );
      }

      const id = cartIdFor(request);
      if (id) carts.set(id, []);

      return redirect(`/order-success/${orderId}`);
    }

    if (url.pathname.startsWith("/order-success/") && request.method === "GET") {
      const orderId = Number(url.pathname.split("/")[2]);
      const row = db.query(
        "SELECT customer_name, total, payment_method FROM orders WHERE id = ?",
        [orderId]
      );

      if (!row.length) return new Response("Order not found", { status: 404 });

      return new Response(
        page("Order confirmed", `${layoutHeader()}<main class="container section narrow">
          <div class="success-card">
            <p class="eyebrow">Thank you</p>
            <h1>Order confirmed 🎉</h1>
            <p>Your order number is <strong>#${orderId}</strong>.</p>
            <p>Payment method: <strong>${escapeHtml(row[0][2])}</strong></p>
            <p>Total: <strong>৳${Number(row[0][1]).toFixed(0)}</strong></p>
            <a class="btn" href="/products">Continue shopping</a>
          </div>
        </main>`),
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }

    // ---------- Admin login ----------
    if (url.pathname === "/admin/login" && request.method === "GET") {
      if (isAdmin(request)) return redirect("/admin/dashboard");
      const html = await readView("admin/login.html");
      return new Response(
        html.replace("{{ERROR}}", ""),
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }

    if (url.pathname === "/admin/login" && request.method === "POST") {
      const form = await request.formData();
      const username = form.get("username")?.toString();
      const password = form.get("password")?.toString();

      if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        const html = await readView("admin/login.html");
        return new Response(
          html.replace("{{ERROR}}", `<p class="error-box">Invalid username or password.</p>`),
          { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      const token = crypto.randomUUID();
      sessions.set(token, { username, createdAt: Date.now() });

      const response = redirect("/admin/dashboard");
      response.headers.append(
        "Set-Cookie",
        `spark_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
      );
      return response;
    }

    if (url.pathname === "/admin/logout" && request.method === "POST") {
      const token = cookie(request, "spark_admin");
      if (token) sessions.delete(token);

      const response = redirect("/admin/login");
      response.headers.append(
        "Set-Cookie",
        "spark_admin=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax"
      );
      return response;
    }

    // ---------- Admin dashboard ----------
    if (url.pathname === "/admin/dashboard" && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const productCount = db.query("SELECT COUNT(*) FROM products")[0][0];
      const categoryCount = db.query("SELECT COUNT(*) FROM categories")[0][0];
      const orderCount = db.query("SELECT COUNT(*) FROM orders")[0][0];
      const pendingCount = db.query("SELECT COUNT(*) FROM orders WHERE status = 'Pending'")[0][0];

      const content = `
        <div class="page-title"><p class="eyebrow">Admin</p><h1>Dashboard</h1></div>
        <div class="stats-grid">
          <a class="stat-card" href="/admin/products"><span>Products</span><strong>${productCount}</strong></a>
          <a class="stat-card" href="/admin/categories"><span>Categories</span><strong>${categoryCount}</strong></a>
          <a class="stat-card" href="/admin/orders"><span>Orders</span><strong>${orderCount}</strong></a>
          <a class="stat-card" href="/admin/orders?status=Pending"><span>Pending</span><strong>${pendingCount}</strong></a>
        </div>
        <div class="admin-grid">
          <a class="action-card" href="/admin/products/add"><h2>Add product</h2><p>Upload a photo, price, stock and variants.</p></a>
          <a class="action-card" href="/admin/categories"><h2>Manage categories</h2><p>Create and organise product categories.</p></a>
          <a class="action-card" href="/admin/orders"><h2>Manage orders</h2><p>Review customers and update order status.</p></a>
        </div>`;

      return new Response(adminPage("Dashboard", content), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    // ---------- Admin products ----------
    if (url.pathname === "/admin/products" && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const rows = getProducts();
      const productRows = rows.map(row => `
        <tr>
          <td>${row[10] ? `<img class="table-image" src="${row[10]}" alt="">` : "—"}</td>
          <td><strong>${escapeHtml(row[2])}</strong><br><small>${escapeHtml(row[9] ?? "")}</small></td>
          <td>৳${Number(row[5]).toFixed(0)}</td>
          <td>${row[7] > 0 ? row[7] : `<span class="out">Out of stock</span>`}</td>
          <td>${row[6] ? escapeHtml(row[6]) : "—"}</td>
          <td>
            <a class="btn btn-small" href="/admin/products/edit/${row[0]}">Edit</a>
            <form class="inline-form" method="POST" action="/admin/products/delete/${row[0]}" onsubmit="return confirm('Delete this product?')">
              <button class="danger-button" type="submit">Delete</button>
            </form>
          </td>
        </tr>
      `).join("");

      const content = `
        <div class="page-title page-title-row">
          <div><p class="eyebrow">Catalogue</p><h1>Products</h1></div>
          <a class="btn" href="/admin/products/add">+ Add product</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Image</th><th>Product</th><th>Price</th><th>Stock</th><th>SKU</th><th>Actions</th></tr></thead>
            <tbody>${productRows || `<tr><td colspan="6">No products yet.</td></tr>`}</tbody>
          </table>
        </div>`;

      return new Response(adminPage("Products", content), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    // ---------- Admin add product ----------
    if (url.pathname === "/admin/products/add" && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const html = await readView("admin/product-form.html");

return new Response(
  page(
    "Add product",
    html
      .replaceAll("{{FORM_TITLE}}", "Add product")
      .replaceAll("{{ACTION}}", "/admin/products/add")
      .replaceAll("{{NAME}}", "")
      .replaceAll("{{DESCRIPTION}}", "")
      .replaceAll("{{PRICE}}", "")
      .replaceAll("{{STOCK}}", "")
      .replaceAll("{{SKU}}", "")
      .replaceAll("{{CATEGORIES}}", categoryOptions())
      .replaceAll("{{VARIANTS}}", variantRows())
      .replaceAll("{{CURRENT_IMAGE}}", "")
      .replaceAll("{{ID}}", "")
  ),
  { headers: { "content-type": "text/html; charset=utf-8" } }
);
    }

    if (url.pathname === "/admin/products/add" && request.method === "POST") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const form = await request.formData();
      const name = form.get("name")?.toString().trim();
      const description = form.get("description")?.toString().trim() ?? "";
      const price = Number(form.get("price"));
      const stock = Number(form.get("stock"));
      const sku = form.get("sku")?.toString().trim() || null;
      const categoryId = Number(form.get("category_id")) || null;
      const variantName = form.get("variant_name")?.toString().trim();
      const variantValue = form.get("variant_value")?.toString().trim();
      const images = form.getAll("images");

      if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
        return new Response("Please enter valid product information.", { status: 400 });
      }

      const slugBase = slugify(name);
      let slug = slugBase || `product-${Date.now()}`;
      let n = 2;
      while (db.query("SELECT id FROM products WHERE slug = ?", [slug]).length) {
        slug = `${slugBase}-${n++}`;
      }

      db.query(`
        INSERT INTO products
        (category_id, name, slug, description, price, sku, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [categoryId, name, slug, description, price, sku, stock]);

      const productId = db.query("SELECT last_insert_rowid()")[0][0];

      if (variantName && variantValue) {
        for (const value of variantValue.split(",").map(v => v.trim()).filter(Boolean)) {
          db.query(
            "INSERT INTO product_variants (product_id, variant_name, variant_value) VALUES (?, ?, ?)",
            [productId, variantName, value]
          );
        }
      }

      for (const [index, image] of images.entries()) {
  const uploaded = await saveUploadedImage(image);

  if (uploaded) {
    db.query(
      "INSERT INTO product_images (product_id, image_path, is_main) VALUES (?, ?, ?)",
      [productId, uploaded.webPath, index === 0 ? 1 : 0]
    );
  }
}

      return redirect("/admin/products");
    }

    // ---------- Admin edit product ----------
    if (url.pathname.startsWith("/admin/products/edit/") && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const id = Number(url.pathname.split("/").pop());
      const product = getProduct(id);
      if (!product) return new Response("Product not found", { status: 404 });

      const html = await readView("admin/product-form.html");
      const currentImage = product.imagePath
  ? `<img class="current-image" src="${product.imagePath}" alt="${escapeHtml(product.name)}">`
  : "";

return new Response(
  page(
    "Edit product",
    html
      .replaceAll("{{FORM_TITLE}}", "Edit product")
      .replaceAll("{{ACTION}}", `/admin/products/edit/${id}`)
      .replaceAll("{{NAME}}", escapeHtml(product.name))
      .replaceAll("{{DESCRIPTION}}", escapeHtml(product.description))
      .replaceAll("{{PRICE}}", product.price.toFixed(0))
      .replaceAll("{{STOCK}}", String(product.stock))
      .replaceAll("{{SKU}}", escapeHtml(product.sku))
      .replaceAll("{{CATEGORIES}}", categoryOptions(product.categoryId))
      .replaceAll("{{VARIANTS}}", variantRows(product.variants))
      .replaceAll("{{CURRENT_IMAGE}}", currentImage)
      .replaceAll("{{ID}}", String(id))
  ),
  {
    headers: { "content-type": "text/html; charset=utf-8" }
  }
);
    }

    if (url.pathname.startsWith("/admin/products/edit/") && request.method === "POST") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const id = Number(url.pathname.split("/").pop());
      const product = getProduct(id);
      if (!product) return new Response("Product not found", { status: 404 });

      const form = await request.formData();
      const name = form.get("name")?.toString().trim();
      const description = form.get("description")?.toString().trim() ?? "";
      const price = Number(form.get("price"));
      const stock = Number(form.get("stock"));
      const sku = form.get("sku")?.toString().trim() || null;
      const categoryId = Number(form.get("category_id")) || null;
      const variantName = form.get("variant_name")?.toString().trim();
      const variantValue = form.get("variant_value")?.toString().trim();
      const images = form.getAll("images");

      if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
        return new Response("Please enter valid product information.", { status: 400 });
      }

      let slug = slugify(name) || `product-${id}`;
      const duplicate = db.query("SELECT id FROM products WHERE slug = ? AND id <> ?", [slug, id]);
      if (duplicate.length) slug = `${slug}-${id}`;

      db.query(`
        UPDATE products
        SET category_id = ?, name = ?, slug = ?, description = ?,
            price = ?, sku = ?, stock = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [categoryId, name, slug, description, price, sku, stock, id]);

      db.query("DELETE FROM product_variants WHERE product_id = ?", [id]);

      if (variantName && variantValue) {
        for (const value of variantValue.split(",").map(v => v.trim()).filter(Boolean)) {
          db.query(
            "INSERT INTO product_variants (product_id, variant_name, variant_value) VALUES (?, ?, ?)",
            [id, variantName, value]
          );
        }
      }

      for (const [index, image] of images.entries()) {
  const uploaded = await saveUploadedImage(image);

  if (uploaded) {
    if (index === 0) {
      db.query(
        "DELETE FROM product_images WHERE product_id = ?",
        [id]
      );
    }

    db.query(
      "INSERT INTO product_images (product_id, image_path, is_main) VALUES (?, ?, ?)",
      [id, uploaded.webPath, index === 0 ? 1 : 0]
    );
  }
}

return redirect("/admin/products");
}

    if (url.pathname.startsWith("/admin/products/delete/") && request.method === "POST") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const id = Number(url.pathname.split("/").pop());
      db.query("DELETE FROM products WHERE id = ?", [id]);
      return redirect("/admin/products");
    }

    // ---------- Admin categories ----------
    if (url.pathname === "/admin/categories" && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const rows = db.query("SELECT id, name, slug, description FROM categories ORDER BY name");
      const list = rows.map(([id, name, slug, description]) => `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(slug)}</td>
          <td>${escapeHtml(description ?? "")}</td>
          <td>
            <form method="POST" action="/admin/categories/delete/${id}" onsubmit="return confirm('Delete this category?')">
              <button class="danger-button" type="submit">Delete</button>
            </form>
          </td>
        </tr>
      `).join("");

      const content = `
        <div class="page-title"><p class="eyebrow">Catalogue</p><h1>Categories</h1></div>
        <div class="two-column">
          <section class="panel">
            <h2>Add category</h2>
            <form method="POST" action="/admin/categories">
              <label>Name<input name="name" required></label>
              <label>Description<textarea name="description"></textarea></label>
              <button class="btn" type="submit">Add category</button>
            </form>
          </section>
          <section class="panel">
            <h2>Existing categories</h2>
            <div class="table-wrap"><table>
              <thead><tr><th>Name</th><th>Slug</th><th>Description</th><th></th></tr></thead>
              <tbody>${list || `<tr><td colspan="4">No categories yet.</td></tr>`}</tbody>
            </table></div>
          </section>
        </div>`;

      return new Response(adminPage("Categories", content), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/admin/categories" && request.method === "POST") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const form = await request.formData();
      const name = form.get("name")?.toString().trim();
      const description = form.get("description")?.toString().trim() ?? "";
      if (!name) return new Response("Category name is required.", { status: 400 });

      let slug = slugify(name);
      let n = 2;
      while (db.query("SELECT id FROM categories WHERE slug = ?", [slug]).length) {
        slug = `${slugify(name)}-${n++}`;
      }

      db.query(
        "INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)",
        [name, slug, description]
      );
      return redirect("/admin/categories");
    }

    if (url.pathname.startsWith("/admin/categories/delete/") && request.method === "POST") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const id = Number(url.pathname.split("/").pop());
      db.query("DELETE FROM categories WHERE id = ?", [id]);
      return redirect("/admin/categories");
    }

    // ---------- Admin orders ----------
    if (url.pathname === "/admin/orders" && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const status = url.searchParams.get("status") ?? "";
      const rows = status
        ? db.query(`
            SELECT id, customer_name, phone, payment_method, status, total, created_at
            FROM orders WHERE status = ? ORDER BY id DESC
          `, [status])
        : db.query(`
            SELECT id, customer_name, phone, payment_method, status, total, created_at
            FROM orders ORDER BY id DESC
          `);

      const orderRows = rows.map(row => `
        <tr>
          <td>#${row[0]}</td>
          <td>${escapeHtml(row[1])}<br><small>${escapeHtml(row[2])}</small></td>
          <td>${escapeHtml(row[3])}</td>
          <td><span class="status">${escapeHtml(row[4])}</span></td>
          <td>৳${Number(row[5]).toFixed(0)}</td>
          <td>${escapeHtml(row[6])}</td>
          <td><a class="btn btn-small" href="/admin/orders/${row[0]}">View</a></td>
        </tr>
      `).join("");

      const filter = ORDER_STATUSES.map(s =>
        `<a class="${status === s ? "active-filter" : ""}" href="/admin/orders?status=${encodeURIComponent(s)}">${s}</a>`
      ).join(" ");

      const content = `
        <div class="page-title"><p class="eyebrow">Sales</p><h1>Orders</h1></div>
        <div class="filters"><a href="/admin/orders">All</a>${filter}</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th>Payment</th><th>Status</th><th>Total</th><th>Date</th><th></th></tr></thead>
            <tbody>${orderRows || `<tr><td colspan="7">No orders found.</td></tr>`}</tbody>
          </table>
        </div>`;

      return new Response(adminPage("Orders", content), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname.startsWith("/admin/orders/") && url.pathname.endsWith("/status") && request.method === "POST") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const parts = url.pathname.split("/");
      const orderId = Number(parts[3]);
      const form = await request.formData();
      const status = form.get("status")?.toString();

      if (!ORDER_STATUSES.includes(status)) {
        return new Response("Invalid status", { status: 400 });
      }

      db.query("UPDATE orders SET status = ? WHERE id = ?", [status, orderId]);
      return redirect(`/admin/orders/${orderId}`);
    }

    if (url.pathname.startsWith("/admin/orders/") && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;

      const orderId = Number(url.pathname.split("/")[3]);
      const order = db.query(`
        SELECT id, customer_name, phone, email, address, payment_method, status, total, created_at
        FROM orders WHERE id = ?
      `, [orderId]);

      if (!order.length) return new Response("Order not found", { status: 404 });

      const row = order[0];
      const items = db.query(`
        SELECT product_name, price, quantity
        FROM order_items WHERE order_id = ? ORDER BY id
      `, [orderId]);

      const itemRows = items.map(item => `
        <tr>
          <td>${escapeHtml(item[0])}</td>
          <td>৳${Number(item[1]).toFixed(0)}</td>
          <td>${item[2]}</td>
          <td>৳${(Number(item[1]) * Number(item[2])).toFixed(0)}</td>
        </tr>
      `).join("");

      const statusOptions = ORDER_STATUSES.map(s =>
        `<option ${s === row[6] ? "selected" : ""}>${s}</option>`
      ).join("");

      const content = `
        <div class="page-title page-title-row">
          <div><p class="eyebrow">Order #${orderId}</p><h1>Order details</h1></div>
          <a class="btn btn-light" href="/admin/orders">Back to orders</a>
        </div>
        <div class="two-column">
          <section class="panel">
            <h2>Customer</h2>
            <p><strong>${escapeHtml(row[1])}</strong></p>
            <p>${escapeHtml(row[2])}</p>
            <p>${escapeHtml(row[3] ?? "")}</p>
            <p>${escapeHtml(row[4])}</p>
            <hr>
            <p>Payment: <strong>${escapeHtml(row[5])}</strong></p>
            <p>Total: <strong>৳${Number(row[7]).toFixed(0)}</strong></p>
            <p>Created: ${escapeHtml(row[8])}</p>
          </section>
          <section class="panel">
            <h2>Update status</h2>
            <form method="POST" action="/admin/orders/${orderId}/status">
              <label>Status<select name="status">${statusOptions}</select></label>
              <button class="btn" type="submit">Save status</button>
            </form>
          </section>
        </div>
        <section class="panel">
          <h2>Items</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Product</th><th>Price</th><th>Qty</th><th>Total</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table></div>
        </section>`;

      return new Response(adminPage(`Order #${orderId}`, content), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    return new Response("404 - Page Not Found", { status: 404 });
  } catch (error) {
    console.error(error);
    return new Response(
      `500 - ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
      { status: 500 }
    );
  }
});

console.log(`Spark Corner running at http://localhost:${PORT}`);
