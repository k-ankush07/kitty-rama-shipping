import { useState, useEffect, useRef } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const API_VERSION = "2024-01";

const CREATE_ARTICLE_MUTATION = `
  mutation CreateArticle($article: ArticleInput!) {
    articleCreate(article: $article) {
      article {
        id
        title
        handle
        publishedAt
        blog { title }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Shared style tokens ──────────────────────────────────────────────────────
const styles = {
  input:
    "w-full text-sm px-3 py-2 border border-gray-200 rounded-lg outline-none bg-white text-gray-900 focus:border-violet-500 focus:ring-2 focus:ring-violet-100 transition",
  textarea:
    "w-full text-sm px-3 py-2 border border-gray-200 rounded-lg outline-none bg-white text-gray-900 resize-y leading-relaxed focus:border-violet-500 focus:ring-2 focus:ring-violet-100 transition",
  select:
    "w-full text-sm px-3 py-2 border border-gray-200 rounded-lg outline-none bg-white text-gray-900 focus:border-violet-500 focus:ring-2 focus:ring-violet-100 transition cursor-pointer",
  btnGhost:
    "px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition",
  btnPrimary:
    "px-5 py-2 text-sm font-semibold text-white bg-gray-900 rounded-lg hover:bg-gray-700 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed",
  btnSm:
    "px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 cursor-pointer transition whitespace-nowrap",
  card: "bg-white border border-gray-200 rounded-xl shadow-sm",
  cardHeader:
    "px-5 py-3 border-b border-gray-100 flex items-center justify-between",
  cardTitle:
    "text-xs font-bold text-gray-500 uppercase tracking-widest",
  cardBody: "p-5",
  sectionEyebrow:
    "text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 pb-3 border-b border-gray-100 flex items-center gap-2",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function fetchShopifyConfig() {
  let shop = null;
  let token = null;

  const params = new URLSearchParams(window.location.search);
  shop = params.get("shop") || params.get("myshopify_domain");

  if (!shop && window.__SHOPIFY_DEV_HOST__) {
    shop = atob(window.__SHOPIFY_DEV_HOST__).split("/")[0];
  }

  if (!shop)  shop  = sessionStorage.getItem("shopify_shop")  || localStorage.getItem("shopify_shop");
  if (!token) token = sessionStorage.getItem("shopify_token") || localStorage.getItem("shopify_token");

  if (!token && window.shopify?.idToken) {
    try { token = await window.shopify.idToken(); } catch (_) {}
  }

  return { shop, token };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, hint, desc, children }) {
  return (
    <div className="mb-4 last:mb-0">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {hint && <span className="font-normal text-gray-400 ml-1.5 text-xs">{hint}</span>}
      </label>
      {children}
      {desc && <p className="mt-1 text-xs text-gray-400">{desc}</p>}
    </div>
  );
}

function TagInput({ tags, setTags }) {
  const [input, setInput] = useState("");

  const add = () => {
    const v = input.trim();
    if (v && !tags.includes(v)) setTags([...tags, v]);
    setInput("");
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Add tag…"
          className={styles.input}
        />
        <button onClick={add} className={styles.btnSm}>Add</button>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center bg-violet-50 border border-violet-200 rounded-full text-xs px-3 py-1 text-violet-700 gap-1"
            >
              {t}
              <button
                onClick={() => setTags(tags.filter((x) => x !== t))}
                className="text-violet-400 hover:text-violet-700 text-sm leading-none bg-transparent border-none cursor-pointer"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBanner({ status }) {
  if (!status) return null;

  const map = {
    loading: "bg-amber-50 border-amber-300 text-amber-800",
    success: "bg-green-50 border-green-300 text-green-800",
    error:   "bg-red-50 border-red-300 text-red-800",
  };
  const icons = { loading: "⏳", success: "✓", error: "✕" };

  return (
    <div className={`flex items-start gap-2 border rounded-lg px-4 py-3 text-sm mb-4 ${map[status.type]}`}>
      <span className="shrink-0 mt-0.5">{icons[status.type]}</span>
      <span>{status.message}</span>
    </div>
  );
}

// ─── Image Upload ─────────────────────────────────────────────────────────────

function ImageUpload({ images, setImages }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef();

  const processFiles = (files) => {
    const valid = Array.from(files).filter(
      (f) => f.type.startsWith("image/") && f.size <= 10 * 1024 * 1024
    );
    if (!valid.length) return;

    setUploading(true);
    setProgress(0);
    let loaded = 0;

    valid.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setImages((prev) => [...prev, { name: file.name, dataUrl: ev.target.result }]);
        loaded++;
        setProgress(Math.round((loaded / valid.length) * 100));
        if (loaded === valid.length) {
          setTimeout(() => { setUploading(false); setProgress(0); }, 600);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (index) =>
    setImages((prev) => prev.filter((_, i) => i !== index));

  const setFeatured = (index) =>
    setImages((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      return [item, ...next];
    });

  return (
    <div>
      {/* Drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          processFiles(e.dataTransfer.files);
        }}
        className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition
          ${dragging
            ? "border-violet-500 bg-violet-50"
            : "border-gray-200 bg-gray-50 hover:border-violet-400 hover:bg-violet-50"
          }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { processFiles(e.target.files); e.target.value = ""; }}
        />
        <div className="text-3xl mb-2">🖼️</div>
        <p className="text-sm font-semibold text-gray-700 mb-1">
          Drop images here or <span className="text-violet-600">browse</span>
        </p>
        <p className="text-xs text-gray-400">PNG, JPG, GIF, WebP · Max 10 MB each</p>
      </div>

      {/* Progress bar */}
      {uploading && (
        <div className="mt-3 bg-gray-200 rounded-full h-1 overflow-hidden">
          <div
            className="h-full bg-violet-500 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Image preview grid */}
      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mt-3">
          {images.map((img, i) => (
            <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gray-100 group">
              <img src={img.dataUrl} alt={img.name} className="w-full h-full object-cover" />

              {/* Featured badge */}
              {i === 0 && (
                <span className="absolute top-1.5 left-1.5 bg-violet-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full tracking-wider">
                  FEATURED
                </span>
              )}

              {/* Hover actions */}
              <div className="absolute inset-0 bg-gray-900/60 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-1.5">
                {i !== 0 && (
                  <button
                    onClick={() => setFeatured(i)}
                    className="text-xs bg-white/90 hover:bg-white text-gray-800 font-medium px-2 py-1 rounded cursor-pointer border-none"
                  >
                    ★ Feature
                  </button>
                )}
                <button
                  onClick={() => removeImage(i)}
                  className="text-xs bg-white/90 hover:bg-white text-red-600 font-medium px-2 py-1 rounded cursor-pointer border-none"
                >
                  ✕ Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-xs text-gray-400">
        Images are encoded as base64. The first image is marked as <strong>Featured</strong>.
      </p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Dashboard() {
  // Content
  const [title, setTitle]       = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [images, setImages]     = useState([]);

  // Organization
  const [author, setAuthor]   = useState("");
  const [blogId, setBlogId]   = useState("");
  const [tags, setTags]       = useState([]);

  // Publishing
  const [published, setPublished]         = useState(false);
  const [themeTemplate, setThemeTemplate] = useState("artist");

  // Metafields
  const [affiliation, setAffiliation]                 = useState("");
  const [cymbalSetup, setCymbalSetup]                 = useState("");
  const [cymbalSetupImage, setCymbalSetupImage]       = useState("");
  const [featuredBannerImage, setFeaturedBannerImage] = useState("");
  const [q1, setQ1] = useState("");
  const [q2, setQ2] = useState("");
  const [q3, setQ3] = useState("");
  const [q4, setQ4] = useState("");
  const [goToProducts, setGoToProducts] = useState("");

  // API config
  const [storeDomain, setStoreDomain] = useState("");
  const [apiToken, setApiToken]       = useState("");
  const [configLoading, setConfigLoading] = useState(true);

  // UI state
  const [activeTab, setActiveTab]         = useState("content");
  const [status, setStatus]               = useState(null);
  const [saving, setSaving]               = useState(false);
  const [createdArticle, setCreatedArticle] = useState(null);

  // ── Auto-load Shopify config ──────────────────────────────────────────────
  useEffect(() => {
    async function loadConfig() {
      setConfigLoading(true);
      try {
        const { shop, token } = await fetchShopifyConfig();
        if (shop)  setStoreDomain(shop);
        if (token) setApiToken(token);
      } catch (_) {}
      setConfigLoading(false);
    }
    loadConfig();
  }, []);

  // ── Build GraphQL payload ─────────────────────────────────────────────────
  function buildMetafields() {
    const raw = [
      { namespace: "custom", key: "affiliation",           value: affiliation,         type: "single_line_text_field" },
      { namespace: "custom", key: "cymbal_setup",          value: cymbalSetup,         type: "multi_line_text_field"  },
      { namespace: "custom", key: "cymbal_setup_image",    value: cymbalSetupImage,    type: "single_line_text_field" },
      { namespace: "custom", key: "featured_banner_image", value: featuredBannerImage, type: "single_line_text_field" },
      { namespace: "custom", key: "question_1",            value: q1,                  type: "single_line_text_field" },
      { namespace: "custom", key: "question_2",            value: q2,                  type: "single_line_text_field" },
      { namespace: "custom", key: "question_3",            value: q3,                  type: "single_line_text_field" },
      { namespace: "custom", key: "question_4",            value: q4,                  type: "single_line_text_field" },
    ];
    if (goToProducts.trim()) {
      raw.push({
        namespace: "custom",
        key: "go_to_products",
        value: JSON.stringify(goToProducts.split(",").map((s) => s.trim()).filter(Boolean)),
        type: "list.product_reference",
      });
    }
    return raw.filter((f) => f.value.trim());
  }

  function buildVariables() {
    const metafields = buildMetafields();
    const article = {
      title:          title || "Untitled",
      body:           bodyHtml,
      author:         author || undefined,
      blogId:         blogId ? `gid://shopify/Blog/${blogId}` : undefined,
      isPublished:    published,
      templateSuffix: themeTemplate,
      tags:           tags.length ? tags : undefined,
      ...(metafields.length ? { metafields } : {}),
    };
    Object.keys(article).forEach((k) => {
      if (article[k] === "" || article[k] === undefined || article[k] === null) delete article[k];
    });
    return { article };
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handlePost() {
    if (!storeDomain || !apiToken) {
      setStatus({ type: "error", message: "Store domain and API token are required before saving." });
      return;
    }

    setSaving(true);
    setStatus({ type: "loading", message: "Sending request to Shopify GraphQL API…" });
    setCreatedArticle(null);

    try {
      const res = await fetch(
        `https://${storeDomain}/admin/api/${API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": apiToken,
          },
          body: JSON.stringify({ query: CREATE_ARTICLE_MUTATION, variables: buildVariables() }),
        }
      );
      const json = await res.json();
      const result = json?.data?.articleCreate;

      if (result?.userErrors?.length) {
        setStatus({ type: "error", message: "Shopify error: " + result.userErrors.map((e) => e.message).join(", ") });
      } else if (result?.article) {
        setCreatedArticle(result.article);
        setStatus({ type: "success", message: "Article created successfully!" });
      } else {
        setStatus({ type: "error", message: JSON.stringify(json.errors || json) });
      }
    } catch (e) {
      setStatus({ type: "error", message: "Network error: " + e.message });
    } finally {
      setSaving(false);
    }
  }

  // ── Discard ───────────────────────────────────────────────────────────────
  function handleDiscard() {
    if (!window.confirm("Discard all changes?")) return;
    setTitle(""); setBodyHtml(""); setImages([]);
    setAuthor(""); setBlogId(""); setTags([]);
    setPublished(false); setThemeTemplate("artist");
    setAffiliation(""); setCymbalSetup(""); setCymbalSetupImage("");
    setFeaturedBannerImage(""); setQ1(""); setQ2(""); setQ3(""); setQ4("");
    setGoToProducts(""); setStatus(null); setCreatedArticle(null);
  }

  const tabs = [
    { id: "content",    label: "Content"    },
    { id: "metafields", label: "Metafields" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 font-sans px-5 py-6">

      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-5 gap-3">
        <div>
          <p className="text-xs text-gray-400 mb-1">
            Content › Blog posts › <span className="text-gray-700">New article</span>
          </p>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-gray-900">Create blog post</h1>
            <span className="text-[10px] font-bold bg-violet-600 text-white rounded-full px-2.5 py-0.5 tracking-widest">
              GRAPHQL
            </span>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={handleDiscard} className={styles.btnGhost}>Discard</button>
          <button
            onClick={handlePost}
            disabled={saving}
            className={styles.btnPrimary}
          >
            {saving ? "Saving…" : "Save article"}
          </button>
        </div>
      </div>

      <StatusBanner status={status} />

      {/* Created article result */}
      {createdArticle && (
        <div className="bg-green-50 border border-green-300 rounded-xl px-4 py-3 mb-4 text-sm text-green-800">
          <strong className="block mb-1">✓ Article created</strong>
          ID:{" "}
          <code className="font-mono bg-green-100 px-1.5 py-0.5 rounded text-xs">
            {createdArticle.id}
          </code>{" "}
          Handle:{" "}
          <code className="font-mono bg-green-100 px-1.5 py-0.5 rounded text-xs">
            {createdArticle.handle}
          </code>
          {createdArticle.blog && (
            <>
              {" "}Blog:{" "}
              <code className="font-mono bg-green-100 px-1.5 py-0.5 rounded text-xs">
                {createdArticle.blog.title}
              </code>
            </>
          )}
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="flex border-b border-gray-200 mb-5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-5 py-2.5 text-sm border-b-2 -mb-px transition font-medium cursor-pointer bg-transparent border-l-0 border-r-0 border-t-0
              ${activeTab === t.id
                ? "border-violet-600 text-gray-900 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Main grid ── */}
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 272px" }}>

        {/* ── Main column ── */}
        <div className="flex flex-col gap-4">

          {/* CONTENT TAB */}
          {activeTab === "content" && (
            <>
              {/* Title & Body */}
              <div className={styles.card}>
                <div className={styles.cardBody}>
                  <Field label="Title">
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g. Mimmo Di Cicco — Artist"
                      className={styles.input}
                    />
                  </Field>
                  <Field label="Body (HTML)" hint="Full HTML supported">
                    <textarea
                      value={bodyHtml}
                      onChange={(e) => setBodyHtml(e.target.value)}
                      rows={14}
                      placeholder="<p>Artist bio or article content…</p>"
                      className={styles.textarea}
                    />
                  </Field>
                </div>
              </div>

              {/* Image Upload */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <span className={styles.cardTitle}>Images</span>
                  <span className="text-xs text-gray-400">
                    {images.length === 0
                      ? "No images added"
                      : `${images.length} image${images.length > 1 ? "s" : ""}`}
                  </span>
                </div>
                <div className={styles.cardBody}>
                  <ImageUpload images={images} setImages={setImages} />
                </div>
              </div>
            </>
          )}

          {/* METAFIELDS TAB */}
          {activeTab === "metafields" && (
            <div className={styles.card}>
              <div className={styles.cardBody}>

                <div className={styles.sectionEyebrow}>
                  <span>Artist &amp; Setup</span>
                  <span className="text-[10px] font-bold bg-violet-600 text-white rounded-full px-2 py-0.5 tracking-widest">
                    GraphQL
                  </span>
                </div>

                <Field label="Affiliation">
                  <input value={affiliation} onChange={(e) => setAffiliation(e.target.value)}
                    placeholder="Independent, Zildjian, Meinl…" className={styles.input} />
                </Field>

                <Field label="Cymbal setup">
                  <textarea value={cymbalSetup} onChange={(e) => setCymbalSetup(e.target.value)}
                    rows={3} placeholder='15" Special Dry K Custom Hihat, 22" K Constantinople Medium…'
                    className={styles.textarea} />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Cymbal setup image" hint="filename">
                    <input value={cymbalSetupImage} onChange={(e) => setCymbalSetupImage(e.target.value)}
                      placeholder="Mimmo-Di-Cicco-Setup.jpg" className={styles.input} />
                  </Field>
                  <Field label="Featured banner image" hint="filename">
                    <input value={featuredBannerImage} onChange={(e) => setFeaturedBannerImage(e.target.value)}
                      placeholder="Mimmo-Di-Cicco-Header.jpg" className={styles.input} />
                  </Field>
                </div>

                <hr className="border-gray-100 my-4" />
                <div className={styles.sectionEyebrow}>Q&amp;A Answers</div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Question 1">
                    <input value={q1} onChange={(e) => setQ1(e.target.value)}
                      placeholder="My Son, Love, Passion…" className={styles.input} />
                  </Field>
                  <Field label="Question 2">
                    <input value={q2} onChange={(e) => setQ2(e.target.value)}
                      placeholder="Experiment with new styles…" className={styles.input} />
                  </Field>
                  <Field label="Question 3">
                    <input value={q3} onChange={(e) => setQ3(e.target.value)}
                      placeholder='HH 15" Special Dry K Custom…' className={styles.input} />
                  </Field>
                  <Field label="Question 4" hint="optional">
                    <input value={q4} onChange={(e) => setQ4(e.target.value)}
                      placeholder="Optional" className={styles.input} />
                  </Field>
                </div>

                <hr className="border-gray-100 my-4" />
                <div className={styles.sectionEyebrow}>Products</div>

                <Field
                  label="Go-to products"
                  hint="comma-separated GIDs"
                  desc="Shopify Global IDs for product references in the article."
                >
                  <input value={goToProducts} onChange={(e) => setGoToProducts(e.target.value)}
                    placeholder="gid://shopify/Product/123, gid://shopify/Product/456"
                    className={styles.input} />
                </Field>

              </div>
            </div>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="flex flex-col gap-4">

          {/* Organization */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Organization</span>
            </div>
            <div className={styles.cardBody}>
              <Field label="Author">
                <input value={author} onChange={(e) => setAuthor(e.target.value)}
                  placeholder="Jasper Molnar" className={styles.input} />
              </Field>
              <Field label="Blog ID" desc="Numeric Shopify blog ID">
                <input value={blogId} onChange={(e) => setBlogId(e.target.value)}
                  placeholder="123456789" className={styles.input} />
              </Field>
              <Field label="Tags">
                <TagInput tags={tags} setTags={setTags} />
              </Field>
            </div>
          </div>

          {/* Publishing */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Publishing</span>
            </div>
            <div className={styles.cardBody}>
              <Field label="Visibility">
                <select
                  value={published ? "true" : "false"}
                  onChange={(e) => setPublished(e.target.value === "true")}
                  className={styles.select}
                >
                  <option value="false">Draft</option>
                  <option value="true">Published</option>
                </select>
              </Field>
              <Field label="Theme template">
                <select value={themeTemplate} onChange={(e) => setThemeTemplate(e.target.value)}
                  className={styles.select}>
                  <option value="artist">artist</option>
                  <option value="default">default</option>
                  <option value="interview">interview</option>
                  <option value="review">review</option>
                </select>
              </Field>
            </div>
          </div>

          {/* API Config */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>API Configuration</span>
            </div>
            <div className={styles.cardBody}>
              {configLoading ? (
                <p className="text-xs text-gray-400">Detecting Shopify config…</p>
              ) : (
                <>
                  <Field label="Store domain">
                    <input value={storeDomain} onChange={(e) => setStoreDomain(e.target.value)}
                      placeholder="your-store.myshopify.com" className={styles.input} />
                  </Field>
                  <Field label="Access token" desc="Admin API access token">
                    <input value={apiToken} onChange={(e) => setApiToken(e.target.value)}
                      type="password" placeholder="shpat_…" className={styles.input} />
                  </Field>
                </>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}