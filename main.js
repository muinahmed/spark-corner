import db from "./database/database.js";

const uploadDir =
  `${Deno.env.get("DATA_DIR") || "./public"}/uploads/products`;

const PORT = 8000;
const carts = new Map();
const sessions = new Map();

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "muin123";

const ORDER_STATUSES = ["Pending", "Confirmed", "Processing", "Out for Delivery", "Delivered", "Cancelled"];

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

function cartResponse(request, response, cartId = null) {
  const existing = cartIdFor(request);

  if (existing) return response;

  const id = cartId || ensureCart(request);
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
           p.price, p.sku, p.stock, p.is_active, p.skin_concern, p.ingredients,
           p.how_to_use, p.material, p.size_info, p.care_instructions,
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
    SELECT id, variant_name, variant_value, image_path, stock
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
    skinConcern: row[9] ?? "",
    ingredients: row[10] ?? "",
    howToUse: row[11] ?? "",
    material: row[12] ?? "",
    sizeInfo: row[13] ?? "",
    careInstructions: row[14] ?? "",
    categoryName: row[15] ?? "Uncategorised",
    imagePath: row[16] ?? "",
    images: images.map(image => ({
  path: image[0],
  isMain: Number(image[1]) === 1
})),
    variants: variants.map(v => ({
      id: v[0],
      name: v[1],
      value: v[2],
      imagePath: v[3] ?? "",
      stock: v[4] === null ? null : Number(v[4])
    }))
  };
}

function getCartDetails(request) {
  return getCart(request).map(item => {
    const product = getProduct(item.productId);
    if (!product) return null;
    const variant = item.variantId
      ? product.variants.find(entry => entry.id === item.variantId)
      : null;
    if (item.variantId && !variant) return null;
    return {
      ...item,
      product,
      variant,
      imagePath: variant?.imagePath || product.imagePath,
      availableStock: variant?.stock ?? product.stock,
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
  const diskPath = `${uploadDir}/${fileName}`;
const webPath = `/uploads/products/${fileName}`;

await Deno.mkdir(uploadDir, { recursive: true });

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

function designImagePreview(variants = []) {
  const designs = variants.filter(variant => variant.imagePath);
  if (!designs.length) return "";
  return `<div class="design-preview-list">${designs.map(variant => `
    <figure><img src="${variant.imagePath}" alt="${escapeHtml(variant.value)}"><figcaption>${escapeHtml(variant.value)}</figcaption></figure>
  `).join("")}</div>`;
}

async function saveDesignVariants(productId, variantName, variantValue, variantStock, files = [], existing = []) {
  const names = String(variantValue ?? "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const stocks = String(variantStock ?? "").split(/\r?\n/).map(value => value.trim());
  if (!variantName || !names.length) return;

  for (const [index, value] of names.entries()) {
    const uploaded = await saveUploadedImage(files[index]);
    const old = existing.find(variant => variant.value === value);
    const requestedStock = stocks[index] === "" || stocks[index] === undefined ? old?.stock ?? null : Number(stocks[index]);
    if (requestedStock !== null && (!Number.isInteger(requestedStock) || requestedStock < 0)) {
      throw new Error(`Stock for ${value} must be a whole number of 0 or more.`);
    }
    db.query(
      "INSERT INTO product_variants (product_id, variant_name, variant_value, image_path, stock) VALUES (?, ?, ?, ?, ?)",
      [productId, variantName, value, uploaded?.webPath || old?.imagePath || null, requestedStock]
    );
  }
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
    const data = await Deno.readFile(
  `${Deno.env.get("DATA_DIR") || "./public"}${safePath}`
);

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
        const data = await Deno.readFile(
  `${Deno.env.get("DATA_DIR") || "./public"}${safePath}`
);
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
  const minPrice = url.searchParams.get("min_price")?.trim() ?? "";
  const maxPrice = url.searchParams.get("max_price")?.trim() ?? "";
  const skinConcern = url.searchParams.get("skin_concern")?.trim() ?? "";
  const material = url.searchParams.get("material")?.trim() ?? "";
  const design = url.searchParams.get("design")?.trim() ?? "";

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
      if (minPrice !== "" && Number.isFinite(Number(minPrice))) { sql += " AND p.price >= ?"; params.push(Number(minPrice)); }
      if (maxPrice !== "" && Number.isFinite(Number(maxPrice))) { sql += " AND p.price <= ?"; params.push(Number(maxPrice)); }
      if (skinConcern) { sql += " AND LOWER(COALESCE(p.skin_concern, '')) LIKE LOWER(?)"; params.push(`%${skinConcern}%`); }
      if (material) { sql += " AND LOWER(COALESCE(p.material, '')) LIKE LOWER(?)"; params.push(`%${material}%`); }
      if (design) { sql += " AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND LOWER(v.variant_value) LIKE LOWER(?))"; params.push(`%${design}%`); }

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
if (minPrice) queryBase.set("min_price", minPrice);
if (maxPrice) queryBase.set("max_price", maxPrice);
if (skinConcern) queryBase.set("skin_concern", skinConcern);
if (material) queryBase.set("material", material);
if (design) queryBase.set("design", design);

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
       .replace("{{MIN_PRICE}}", escapeHtml(minPrice))
       .replace("{{MAX_PRICE}}", escapeHtml(maxPrice))
       .replace("{{SKIN_CONCERN}}", escapeHtml(skinConcern))
       .replace("{{MATERIAL}}", escapeHtml(material))
       .replace("{{DESIGN}}", escapeHtml(design))
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
             <select name="variant_id" required>
                ${product.variants.map(v =>
                  `<option value="${v.id}" data-image="${escapeHtml(v.imagePath)}" data-stock="${v.stock ?? product.stock}" ${((v.stock ?? product.stock) < 1) ? "disabled" : ""}>${escapeHtml(v.value)}${((v.stock ?? product.stock) < 1) ? " — Out of stock" : ""}</option>`
                ).join("")}
             </select>
           </label>`
        : "";

      const primaryImage = product.imagePath || product.variants.find(variant => variant.imagePath)?.imagePath;
      const image = primaryImage
        ? `<img src="${primaryImage}" alt="${escapeHtml(product.name)}">`
        : `<div class="image-placeholder large">No image</div>`;

      const html = await readView("product.html");
      const detailRows = [
        ["Skin concern", product.skinConcern], ["Ingredients", product.ingredients],
        ["How to use", product.howToUse], ["Material", product.material],
        ["Size", product.sizeInfo], ["Care", product.careInstructions]
      ].filter(([, value]) => value).map(([label, value]) =>
        `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`
      ).join("");
      const productDetails = detailRows ? `<dl class="product-details">${detailRows}</dl>` : "";
      const related = db.query(`
        SELECT p.id, p.name, p.price, COALESCE((SELECT image_path FROM product_images WHERE product_id = p.id AND is_main = 1 LIMIT 1), '')
        FROM products p WHERE p.is_active = 1 AND p.id <> ? AND (p.category_id = ? OR ? IS NULL)
        ORDER BY p.id DESC LIMIT 3
      `, [product.id, product.categoryId, product.categoryId]);
      const relatedCards = related.map(row => `<article class="product-card"><a href="/product/${row[0]}">${row[3] ? `<img src="${row[3]}" alt="${escapeHtml(row[1])}">` : `<div class="image-placeholder">Spark Corner</div>`}</a><div class="product-card-body"><h3>${escapeHtml(row[1])}</h3><strong>৳${Number(row[2]).toFixed(0)}</strong><a class="text-link" href="/product/${row[0]}">View product →</a></div></article>`).join("");
      const relatedProducts = relatedCards ? `<section class="related-products"><div class="page-title"><p class="eyebrow">You may also like</p><h2>Complete your routine</h2></div><div class="product-grid">${relatedCards}</div></section>` : "";
      const imageGallery = [...product.variants.filter(variant => variant.imagePath).map(variant => ({ path: variant.imagePath })), ...product.images].map((img) => `
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
       .replace("{{PRODUCT_DETAILS}}", productDetails)
       .replace("{{RELATED_PRODUCTS}}", relatedProducts)
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
      const variantId = Number(form.get("variant_id")) || null;

      const product = getProduct(productId);
      if (!product) return new Response("Product not found", { status: 404 });
      const selectedVariant = product.variants.find(variant => variant.id === variantId);
      if (product.variants.length && !selectedVariant) {
        return new Response("Please choose a valid design.", { status: 400 });
      }
      const availableStock = selectedVariant?.stock ?? product.stock;
      if (quantity < 1 || quantity > product.stock || quantity > availableStock) {
        return new Response("Invalid quantity or insufficient stock", { status: 400 });
      }

      const id = ensureCart(request);
      const cart = carts.get(id);
      const existing = cart.find(i => i.productId === productId && i.variantId === variantId);

      if (existing) {
        if (existing.quantity + quantity > availableStock) {
          return new Response("Not enough stock available", { status: 400 });
        }
        existing.quantity += quantity;
      } else {
        cart.push({ productId, quantity, variantId });
      }

      carts.set(id, cart);
return cartResponse(request, redirect("/cart"), id);
    }

    // ---------- Cart ----------
    if (url.pathname === "/cart" && request.method === "GET") {
      const details = getCartDetails(request);
      const items = details.map(item => `
        <div class="cart-item">
          <div class="cart-image">
            ${item.imagePath
              ? `<img src="${item.imagePath}" alt="${escapeHtml(item.product.name)}">`
              : `<div class="image-placeholder">No image</div>`}
          </div>
          <div class="cart-info">
            <h2>${escapeHtml(item.product.name)}</h2>
            ${item.variant ? `<p class="variant">${escapeHtml(item.variant.name)}: ${escapeHtml(item.variant.value)}</p>` : ""}
            <p class="price">৳${item.product.price.toFixed(0)}</p>
            <div class="cart-actions">
              <form method="POST" action="/cart/update">
                <input type="hidden" name="product_id" value="${item.product.id}">
                <input type="hidden" name="variant_id" value="${item.variantId ?? ""}">
                <input type="hidden" name="quantity" value="${Math.max(1, item.quantity - 1)}">
                <button type="submit" ${item.quantity <= 1 ? "disabled" : ""}>−</button>
              </form>
              <span>${item.quantity}</span>
              <form method="POST" action="/cart/update">
                <input type="hidden" name="product_id" value="${item.product.id}">
                <input type="hidden" name="variant_id" value="${item.variantId ?? ""}">
                <input type="hidden" name="quantity" value="${item.quantity + 1}">
                <button type="submit" ${item.quantity >= item.availableStock ? "disabled" : ""}>+</button>
              </form>
              <form method="POST" action="/cart/remove">
                <input type="hidden" name="product_id" value="${item.product.id}">
                <input type="hidden" name="variant_id" value="${item.variantId ?? ""}">
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
      const variantId = Number(form.get("variant_id")) || null;
      const id = cartIdFor(request);
      const cart = id ? (carts.get(id) ?? []) : [];

      const item = cart.find(i => i.productId === productId && i.variantId === variantId);
      const product = getProduct(productId);

      const selectedVariant = product?.variants.find(variant => variant.id === variantId);
      const availableStock = selectedVariant?.stock ?? product?.stock;
      if (!item || !product || quantity < 1 || quantity > availableStock) {
        return new Response("Invalid cart update", { status: 400 });
      }

      item.quantity = quantity;
      carts.set(id, cart);
      return redirect("/cart");
    }

    if (url.pathname === "/cart/remove" && request.method === "POST") {
      const form = await request.formData();
      const productId = Number(form.get("product_id"));
      const variantId = Number(form.get("variant_id")) || null;
      const id = cartIdFor(request);
      const cart = id ? (carts.get(id) ?? []) : [];

      carts.set(
        id,
        cart.filter(i => !(i.productId === productId && i.variantId === variantId))
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
            ${item.variant ? ` <small>(${escapeHtml(item.variant.name)}: ${escapeHtml(item.variant.value)})</small>` : ""}
            × ${item.quantity}
          </span>
          <strong>৳${item.lineTotal.toFixed(0)}</strong>
        </li>
      `).join("");

      const html = await readView("checkout.html");


const subtotal = totalForCart(details).toFixed(0);

const checkoutHtml = html
  .replace("{{ITEMS}}", items)
  .replaceAll("{{SUBTOTAL}}", subtotal)
  .replace("{{TOTAL}}", "Calculated after delivery area is selected");

return new Response(
  page("Checkout", checkoutHtml),
  { headers: { "content-type": "text/html; charset=utf-8" } }
);

    }

    if (url.pathname === "/checkout" && request.method === "POST") {
      const details = getCartDetails(request);
      if (!details.length) return redirect("/cart");

      const form = await request.formData();
      const name = form.get("customer_name")?.toString().trim();
      const phone = form.get("phone")?.toString().trim();
      const phoneConfirmation = form.get("phone_confirmation")?.toString().trim();
      const email = form.get("email")?.toString().trim() || null;
      const address = form.get("address")?.toString().trim();
      const payment = form.get("payment_method")?.toString();
      const deliveryArea = form.get("delivery_area")?.toString();
      const orderNotes = form.get("order_notes")?.toString().trim() || null;

      if (!name || !phone || !address || !["Cash on Delivery", "bKash", "Nagad"].includes(payment) || !["Inside Dhaka", "Outside Dhaka"].includes(deliveryArea)) {
        return new Response("Please complete all required checkout fields.", { status: 400 });
      }
      if (phone !== phoneConfirmation) {
        return new Response("Phone numbers do not match.", { status: 400 });
      }

      for (const item of details) {
        const current = getProduct(item.product.id);
        const currentVariant = item.variantId
          ? current?.variants.find(variant => variant.id === item.variantId)
          : null;
        const availableStock = currentVariant?.stock ?? current?.stock ?? 0;
        if (!current || current.stock < item.quantity || availableStock < item.quantity) {
          return new Response(`Not enough stock for ${escapeHtml(item.product.name)}.`, { status: 400 });
        }
      }

      const subtotal = totalForCart(details);
      const deliveryCharge = deliveryArea === "Inside Dhaka" ? 70 : 130;
      const total = subtotal + deliveryCharge;

      let orderId;
      db.exec("BEGIN IMMEDIATE");
      try {
      db.query(`
        INSERT INTO orders
        (customer_name, phone, email, address, payment_method, status, delivery_area, subtotal, delivery_charge, order_notes, total)
        VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?)
      `, [name, phone, email, address, payment, deliveryArea, subtotal, deliveryCharge, orderNotes, total]);

      orderId = db.query("SELECT last_insert_rowid()")[0][0];

      for (const item of details) {
        const displayName = item.variant
          ? `${item.product.name} (${item.variant.name}: ${item.variant.value})`
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
        if (item.variantId) {
          db.query(
            "UPDATE product_variants SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL",
            [item.quantity, item.variantId]
          );
        }
      }
      db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
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
       .replaceAll("{{SKIN_CONCERN}}", "")
       .replaceAll("{{INGREDIENTS}}", "")
       .replaceAll("{{HOW_TO_USE}}", "")
       .replaceAll("{{MATERIAL}}", "")
       .replaceAll("{{SIZE_INFO}}", "")
       .replaceAll("{{CARE_INSTRUCTIONS}}", "")
       .replaceAll("{{CATEGORIES}}", categoryOptions())
       .replaceAll("{{VARIANT_NAME}}", "Design")
       .replaceAll("{{VARIANT_VALUES}}", "")
       .replaceAll("{{VARIANT_STOCKS}}", "")
       .replaceAll("{{CURRENT_DESIGN_IMAGES}}", "")
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
      const skinConcern = form.get("skin_concern")?.toString().trim() || null;
      const ingredients = form.get("ingredients")?.toString().trim() || null;
      const howToUse = form.get("how_to_use")?.toString().trim() || null;
      const material = form.get("material")?.toString().trim() || null;
      const sizeInfo = form.get("size_info")?.toString().trim() || null;
      const careInstructions = form.get("care_instructions")?.toString().trim() || null;
      const categoryId = Number(form.get("category_id")) || null;
      const variantName = form.get("variant_name")?.toString().trim();
      const variantValue = form.get("variant_value")?.toString().trim();
      const variantStock = form.get("variant_stock")?.toString();
      const variantImages = form.getAll("variant_images");
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
        (category_id, name, slug, description, price, sku, stock, skin_concern, ingredients, how_to_use, material, size_info, care_instructions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [categoryId, name, slug, description, price, sku, stock, skinConcern, ingredients, howToUse, material, sizeInfo, careInstructions]);

      const productId = db.query("SELECT last_insert_rowid()")[0][0];

      await saveDesignVariants(productId, variantName, variantValue, variantStock, variantImages);

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
       .replaceAll("{{SKIN_CONCERN}}", escapeHtml(product.skinConcern))
       .replaceAll("{{INGREDIENTS}}", escapeHtml(product.ingredients))
       .replaceAll("{{HOW_TO_USE}}", escapeHtml(product.howToUse))
       .replaceAll("{{MATERIAL}}", escapeHtml(product.material))
       .replaceAll("{{SIZE_INFO}}", escapeHtml(product.sizeInfo))
       .replaceAll("{{CARE_INSTRUCTIONS}}", escapeHtml(product.careInstructions))
       .replaceAll("{{CATEGORIES}}", categoryOptions(product.categoryId))
       .replaceAll("{{VARIANT_NAME}}", escapeHtml(product.variants[0]?.name || "Design"))
       .replaceAll("{{VARIANT_VALUES}}", escapeHtml(product.variants.map(variant => variant.value).join("\n")))
       .replaceAll("{{VARIANT_STOCKS}}", escapeHtml(product.variants.map(variant => variant.stock ?? "").join("\n")))
       .replaceAll("{{CURRENT_DESIGN_IMAGES}}", designImagePreview(product.variants))
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
      const skinConcern = form.get("skin_concern")?.toString().trim() || null;
      const ingredients = form.get("ingredients")?.toString().trim() || null;
      const howToUse = form.get("how_to_use")?.toString().trim() || null;
      const material = form.get("material")?.toString().trim() || null;
      const sizeInfo = form.get("size_info")?.toString().trim() || null;
      const careInstructions = form.get("care_instructions")?.toString().trim() || null;
      const categoryId = Number(form.get("category_id")) || null;
      const variantName = form.get("variant_name")?.toString().trim();
      const variantValue = form.get("variant_value")?.toString().trim();
      const variantStock = form.get("variant_stock")?.toString();
      const variantImages = form.getAll("variant_images");
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
            price = ?, sku = ?, stock = ?, skin_concern = ?, ingredients = ?, how_to_use = ?,
            material = ?, size_info = ?, care_instructions = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [categoryId, name, slug, description, price, sku, stock, skinConcern, ingredients, howToUse, material, sizeInfo, careInstructions, id]);

      db.query("DELETE FROM product_variants WHERE product_id = ?", [id]);
      await saveDesignVariants(id, variantName, variantValue, variantStock, variantImages, product.variants);

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
      const orderSearch = url.searchParams.get("q")?.trim() ?? "";
      const orderWhere = [];
      const orderParams = [];
      if (status) { orderWhere.push("status = ?"); orderParams.push(status); }
      if (orderSearch) {
        orderWhere.push("(CAST(id AS TEXT) LIKE ? OR customer_name LIKE ? OR phone LIKE ?)");
        orderParams.push(`%${orderSearch}%`, `%${orderSearch}%`, `%${orderSearch}%`);
      }
      const rows = db.query(`
        SELECT id, customer_name, phone, payment_method, status, total, created_at
        FROM orders ${orderWhere.length ? `WHERE ${orderWhere.join(" AND ")}` : ""} ORDER BY id DESC
      `, orderParams);

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
        `<a class="${status === s ? "active-filter" : ""}" href="/admin/orders?status=${encodeURIComponent(s)}${orderSearch ? `&q=${encodeURIComponent(orderSearch)}` : ""}">${s}</a>`
      ).join(" ");

      const content = `
        <div class="page-title"><p class="eyebrow">Sales</p><h1>Orders</h1></div>
        <form class="search-bar" method="GET" action="/admin/orders"><input name="q" value="${escapeHtml(orderSearch)}" placeholder="Search order number, customer, or phone"><button class="btn" type="submit">Search</button></form>
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

    if (url.pathname.startsWith("/admin/orders/") && url.pathname.endsWith("/print") && request.method === "GET") {
      const denied = adminGuard(request);
      if (denied) return denied;
      const orderId = Number(url.pathname.split("/")[3]);
      const order = db.query("SELECT customer_name, phone, address, payment_method, delivery_area, delivery_charge, total, order_notes FROM orders WHERE id = ?", [orderId]);
      if (!order.length) return new Response("Order not found", { status: 404 });
      const items = db.query("SELECT product_name, price, quantity FROM order_items WHERE order_id = ? ORDER BY id", [orderId]);
      const row = order[0];
      const itemRows = items.map(item => `<tr><td>${escapeHtml(item[0])}</td><td>${item[2]}</td><td>${Number(item[1]).toFixed(0)}</td></tr>`).join("");
      return new Response(page(`Packing slip #${orderId}`, `<main class="print-slip"><h1>Spark Corner</h1><p>Packing slip · Order #${orderId}</p><hr><h2>${escapeHtml(row[0])}</h2><p>${escapeHtml(row[1])}<br>${escapeHtml(row[2])}</p><p>Delivery: ${escapeHtml(row[4] ?? "")} · ৳${Number(row[5] ?? 0).toFixed(0)}<br>Payment: ${escapeHtml(row[3])}</p><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead><tbody>${itemRows}</tbody></table><p><strong>Total: ৳${Number(row[6]).toFixed(0)}</strong></p>${row[7] ? `<p>Note: ${escapeHtml(row[7])}</p>` : ""}</main><script>window.print()</script>`), { headers: { "content-type": "text/html; charset=utf-8" } });
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
      const whatsappPhone = String(row[2]).replace(/\D/g, "").replace(/^0/, "880");
      const delivery = db.query(
        "SELECT delivery_area, subtotal, delivery_charge FROM orders WHERE id = ?",
        [orderId]
      )[0];
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
            <p><a class="btn btn-small" target="_blank" rel="noreferrer" href="https://wa.me/${whatsappPhone}?text=${encodeURIComponent(`Hello ${row[1]}, regarding your Spark Corner order #${orderId}.`)}">Message on WhatsApp</a></p>
            <hr>
            <p>Payment: <strong>${escapeHtml(row[5])}</strong></p>
            <p>Delivery: <strong>${escapeHtml(delivery?.[0] ?? "Not recorded")}</strong></p>
            <p>Delivery charge: <strong>${Number(delivery?.[2] ?? 0).toFixed(0)}</strong></p>
            <p>Total: <strong>৳${Number(row[7]).toFixed(0)}</strong></p>
            <p>Created: ${escapeHtml(row[8])}</p>
          </section>
           <section class="panel">
             <h2>Update status</h2>
            <form method="POST" action="/admin/orders/${orderId}/status">
              <label>Status<select name="status">${statusOptions}</select></label>
               <button class="btn" type="submit">Save status</button>
             </form>
             <p><a class="text-link" target="_blank" href="/admin/orders/${orderId}/print">Print packing slip</a></p>
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
