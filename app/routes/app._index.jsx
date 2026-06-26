import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useLoaderData } from "react-router-dom";
import { useFetcher } from "react-router";
import { useState, useRef, useEffect } from "react";

// ─── Metafield definitions to auto-create ────────────────────────────────────
const METAFIELD_DEFINITIONS = [
  { name: "Affiliation",           key: "affiliation",           type: "single_line_text_field", description: "Artist affiliation"         },
  { name: "Cymbal Setup",          key: "cymbal_setup",          type: "multi_line_text_field",  description: "Cymbal setup description"   },
  { name: "Cymbal Setup Image",    key: "cymbal_setup_image",    type: "file_reference",         description: "Cymbal setup image"         },
  { name: "Featured Banner Image", key: "featured_banner_image", type: "file_reference",         description: "Featured banner image"      },
  { name: "Question 1",            key: "question_1",            type: "single_line_text_field", description: "Q&A Answer 1"              },
  { name: "Question 2",            key: "question_2",            type: "single_line_text_field", description: "Q&A Answer 2"              },
  { name: "Question 3",            key: "question_3",            type: "single_line_text_field", description: "Q&A Answer 3"              },
  { name: "Question 4",            key: "question_4",            type: "single_line_text_field", description: "Q&A Answer 4"              },
  { name: "Go-To Products",        key: "go_to_products",        type: "list.product_reference", description: "Linked products"           },
];

async function ensureMetafieldDefinitions(admin) {
  const existingRes = await admin.graphql(`
    {
      metafieldDefinitions(first: 50, ownerType: ARTICLE) {
        edges { node { id key namespace pinnedPosition } }
      }
    }
  `);
  const existingJson = await existingRes.json();
  const existingNodes = existingJson.data.metafieldDefinitions.edges.map((e) => e.node);
  const existingMap = Object.fromEntries(existingNodes.map((n) => [n.key, n]));

  const missing = METAFIELD_DEFINITIONS.filter((d) => !existingMap[d.key]);
  for (const def of missing) {
    try {
      const res = await admin.graphql(
        `mutation CreateMetafieldDefinition($def: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $def) {
            createdDefinition { id key }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            def: {
              name: def.name,
              namespace: "custom",
              key: def.key,
              type: def.type,
              description: def.description,
              ownerType: "ARTICLE",
              pin: true,
            },
          },
        }
      );
      const data = await res.json();
      const errors = data?.data?.metafieldDefinitionCreate?.userErrors;
      if (errors?.length) {
        console.warn(`Metafield def '${def.key}' error:`, errors);
      } else {
        console.log(`✓ Metafield definition created & pinned: ${def.key}`);
        const newId = data?.data?.metafieldDefinitionCreate?.createdDefinition?.id;
        if (newId) existingMap[def.key] = { id: newId, key: def.key, pinnedPosition: null };
      }
    } catch (e) {
      console.warn(`Failed to create metafield def '${def.key}':`, e.message);
    }
  }

  const unpinned = existingNodes.filter((n) => n.pinnedPosition === null);
  for (const node of unpinned) {
    try {
      const pinRes = await admin.graphql(
        `mutation PinMetafieldDefinition($id: ID!) {
          metafieldDefinitionPin(definitionId: $id) {
            pinnedDefinition { id key pinnedPosition }
            userErrors { field message }
          }
        }`,
        { variables: { id: node.id } }
      );
      const pinData = await pinRes.json();
      const pinErrors = pinData?.data?.metafieldDefinitionPin?.userErrors;
      if (pinErrors?.length) {
        console.warn(`Pin error for '${node.key}':`, pinErrors);
      } else {
        console.log(`✓ Pinned existing definition: ${node.key}`);
      }
    } catch (e) {
      console.warn(`Failed to pin '${node.key}':`, e.message);
    }
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────────
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  await ensureMetafieldDefinitions(admin);

  const blogsRes = await admin.graphql(`
    {
      blogs(first: 50) {
        edges { node { id title } }
      }
    }
  `);
  const blogsJson = await blogsRes.json();
  const blogs = blogsJson.data.blogs.edges.map((e) => e.node);

  return json({ shop: session.shop, blogs });
}

// ─── Action ───────────────────────────────────────────────────────────────────
export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── Create Blog ──
  if (intent === "createBlog") {
    const title = formData.get("blogTitle");
    try {
      const res = await admin.graphql(
        `mutation BlogCreate($blog: BlogCreateInput!) {
          blogCreate(blog: $blog) {
            blog { id title }
            userErrors { field message }
          }
        }`,
        { variables: { blog: { title } } }
      );
      const data = await res.json();
      return Response.json(data);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ── Upload file to Shopify Files → returns GID ──
  if (intent === "uploadFile") {
    try {
      const filename = formData.get("filename");
      const mimeType = formData.get("mimeType");
      const attachment = formData.get("attachment"); // pure base64
      const fileSize = formData.get("fileSize");

      // Step 1: Create staged upload target
      const stagedRes = await admin.graphql(
        `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: [{
              filename,
              mimeType,
              fileSize,
              httpMethod: "POST",
              resource: "FILE",
            }],
          },
        }
      );
      const stagedData = await stagedRes.json();
      const stagedErrors = stagedData?.data?.stagedUploadsCreate?.userErrors;
      if (stagedErrors?.length) {
        return Response.json({ error: stagedErrors.map((e) => e.message).join(", ") }, { status: 500 });
      }
      const target = stagedData?.data?.stagedUploadsCreate?.stagedTargets?.[0];
      if (!target) {
        return Response.json({ error: "Failed to create staged upload target" }, { status: 500 });
      }

      // Step 2: POST the file to the staged URL (S3/GCS)
      const buf = Buffer.from(attachment, "base64");
      const uploadForm = new FormData();
      for (const { name, value } of target.parameters) {
        uploadForm.append(name, value);
      }
      uploadForm.append("file", new Blob([buf], { type: mimeType }), filename);

      const uploadRes = await fetch(target.url, { method: "POST", body: uploadForm });
      if (!uploadRes.ok) {
        const body = await uploadRes.text();
        console.error("Staged upload failed:", uploadRes.status, body);
        return Response.json({ error: `Staged upload failed: ${uploadRes.status}` }, { status: 500 });
      }

      // Step 3: Register the uploaded file in Shopify Files → get GID
      const fileCreateRes = await admin.graphql(
        `mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              ... on MediaImage {
                id
                image { url }
              }
              ... on GenericFile {
                id
                url
              }
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            files: [{
              originalSource: target.resourceUrl,
              contentType: "IMAGE",
            }],
          },
        }
      );
      const fileData = await fileCreateRes.json();
      const fileErrors = fileData?.data?.fileCreate?.userErrors;
      if (fileErrors?.length) {
        return Response.json({ error: fileErrors.map((e) => e.message).join(", ") }, { status: 500 });
      }
      const createdFile = fileData?.data?.fileCreate?.files?.[0];
      console.log(`✓ File uploaded to Shopify: ${createdFile?.id}`);
      return Response.json({ gid: createdFile?.id ?? null });
    } catch (e) {
      console.error("uploadFile error:", e);
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ── Attach featured image via REST API ──
  if (intent === "addImage") {
    try {
      const numericId = formData.get("articleId").split("/").pop();
      const blogNumericId = formData.get("blogId").split("/").pop();
      const attachment = formData.get("attachment");
      const filename = formData.get("filename");

      const restRes = await fetch(
        `https://${session.shop}/admin/api/2025-10/blogs/${blogNumericId}/articles/${numericId}.json`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            article: {
              id: Number(numericId),
              image: { attachment, filename },
            },
          }),
        }
      );
      const data = await restRes.json();
      return Response.json({ imageUrl: data?.article?.image?.src ?? null, error: data?.errors ?? null });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ── Create Article ──
  const query = formData.get("query");
  const variables = JSON.parse(formData.get("variables"));
  try {
    const response = await admin.graphql(query, { variables });
    const data = await response.json();
    console.log("articleCreate full:", JSON.stringify({
      userErrors: data?.data?.articleCreate?.userErrors,
      metafields: data?.data?.articleCreate?.article?.metafields?.edges,
    }, null, 2));
    return Response.json(data);
  } catch (e) {
    console.error(e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CREATE_ARTICLE_MUTATION = `
mutation CreateArticle($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article {
      id
      title
      handle
      publishedAt
      blog { title }
      metafields(first: 20) {
        edges {
          node { namespace key value type }
        }
      }
    }
    userErrors { field message }
  }
}
`;

// ─── Design tokens ────────────────────────────────────────────────────────────
const t = {
  accent: "#7c3aed", accentLight: "#ede9fe", accentDark: "#5b21b6",
  gray50: "#f9fafb", gray100: "#f3f4f6", gray200: "#e5e7eb",
  gray300: "#d1d5db", gray400: "#9ca3af", gray500: "#6b7280",
  gray600: "#4b5563", gray700: "#374151", gray900: "#111827",
  green50: "#f0fdf4", green100: "#dcfce7", green300: "#86efac", green800: "#166534",
  red50: "#fef2f2", red300: "#fca5a5", red600: "#dc2626", red800: "#991b1b",
  amber50: "#fffbeb", amber300: "#fcd34d", amber800: "#92400e",
  white: "#ffffff",
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  input: {
    width: "100%", fontSize: 14, padding: "8px 10px",
    border: `1.5px solid ${t.gray200}`, borderRadius: 8, outline: "none",
    background: t.white, color: t.gray900, fontFamily: "inherit",
    boxSizing: "border-box", transition: "border-color .15s",
  },
  textarea: {
    width: "100%", fontSize: 14, padding: "8px 10px",
    border: `1.5px solid ${t.gray200}`, borderRadius: 8, outline: "none",
    background: t.white, color: t.gray900, fontFamily: "inherit",
    boxSizing: "border-box", resize: "vertical", lineHeight: 1.6,
    transition: "border-color .15s",
  },
  select: {
    width: "100%", fontSize: 14, padding: "8px 10px",
    border: `1.5px solid ${t.gray200}`, borderRadius: 8, outline: "none",
    background: t.white, color: t.gray900, fontFamily: "inherit",
    boxSizing: "border-box", cursor: "pointer",
  },
  card: {
    background: t.white, border: `1px solid ${t.gray200}`,
    borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,.06)", overflow: "hidden",
  },
  cardHeader: {
    padding: "12px 18px", borderBottom: `1px solid ${t.gray100}`,
    display: "flex", alignItems: "center", justifyContent: "space-between",
  },
  cardTitle: {
    fontSize: 11, fontWeight: 700, color: t.gray500,
    textTransform: "uppercase", letterSpacing: "0.07em",
  },
  cardBody: { padding: 18 },
  btnPrimary: {
    padding: "8px 20px", background: t.gray900, color: t.white,
    border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14,
    fontWeight: 600, fontFamily: "inherit", transition: "background .15s",
  },
  btnGhost: {
    padding: "8px 16px", background: t.white, color: t.gray700,
    border: `1px solid ${t.gray200}`, borderRadius: 8, cursor: "pointer",
    fontSize: 14, fontWeight: 500, fontFamily: "inherit", transition: "background .15s",
  },
  btnSm: {
    padding: "6px 14px", background: t.gray100, color: t.gray700,
    border: `1px solid ${t.gray200}`, borderRadius: 8, cursor: "pointer",
    fontSize: 13, fontFamily: "inherit", whiteSpace: "nowrap", transition: "background .15s",
  },
  btnAccent: {
    padding: "8px 16px", background: t.accent, color: t.white,
    border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14,
    fontWeight: 600, fontFamily: "inherit", transition: "background .15s",
  },
  sectionEyebrow: {
    fontSize: 11, fontWeight: 700, color: t.gray400,
    textTransform: "uppercase", letterSpacing: "0.07em",
    marginBottom: 14, paddingBottom: 10, borderBottom: `1px solid ${t.gray100}`,
    display: "flex", alignItems: "center", gap: 8,
  },
};

// ─── Field ────────────────────────────────────────────────────────────────────
function Field({ label, hint, desc, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: t.gray700, marginBottom: 5 }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: t.gray400, marginLeft: 6, fontSize: 12 }}>{hint}</span>}
      </label>
      {children}
      {desc && <p style={{ marginTop: 4, fontSize: 12, color: t.gray400 }}>{desc}</p>}
    </div>
  );
}

// ─── Tag input ────────────────────────────────────────────────────────────────
function TagInput({ tags, setTags }) {
  const [input, setInput] = useState("");
  const add = () => {
    const v = input.trim();
    if (v && !tags.includes(v)) setTags([...tags, v]);
    setInput("");
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Add tag..." style={S.input} />
        <button onClick={add} style={S.btnSm}>Add</button>
      </div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {tags.map((tag) => (
            <span key={tag} style={{
              display: "inline-flex", alignItems: "center",
              background: t.accentLight, border: "1px solid #c4b5fd",
              borderRadius: 100, fontSize: 12, padding: "3px 10px", color: t.accentDark, gap: 4,
            }}>
              {tag}
              <button onClick={() => setTags(tags.filter((x) => x !== tag))}
                style={{ background: "none", border: "none", cursor: "pointer", color: t.accent, fontSize: 14, lineHeight: 1, padding: 0 }}>x</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Status banner ────────────────────────────────────────────────────────────
function StatusBanner({ status }) {
  if (!status) return null;
  const map = {
    loading: { bg: t.amber50, border: t.amber300, color: t.amber800, icon: "..." },
    success: { bg: t.green50, border: t.green300, color: t.green800, icon: "OK" },
    error:   { bg: t.red50,   border: t.red300,   color: t.red800,   icon: "!" },
  };
  const s = map[status.type];
  if (!s) return null;
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 8,
      background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: 8, padding: "10px 14px", fontSize: 13, color: s.color, marginBottom: 16,
    }}>
      <span style={{ flexShrink: 0, marginTop: 1, fontWeight: 700 }}>{s.icon}</span>
      <span>{status.message}</span>
    </div>
  );
}

// ─── Create Blog Modal ────────────────────────────────────────────────────────
function CreateBlogModal({ onClose, onCreated }) {
  const [blogTitle, setBlogTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const fetcher = useFetcher();

  useEffect(() => {
    if (!fetcher.data) return;
    const result = fetcher.data?.data?.blogCreate;
    if (result?.userErrors?.length) {
      setErr(result.userErrors.map((e) => e.message).join(", "));
      setCreating(false);
    } else if (result?.blog) {
      onCreated(result.blog);
      onClose();
    } else if (fetcher.data?.error) {
      setErr(fetcher.data.error);
      setCreating(false);
    }
  }, [fetcher.data]);

  const handleCreate = () => {
    if (!blogTitle.trim()) { setErr("Blog title is required."); return; }
    setErr(null);
    setCreating(true);
    fetcher.submit(
      { intent: "createBlog", blogTitle: blogTitle.trim() },
      { method: "post" }
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(17,24,39,.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.white, borderRadius: 14, width: "100%", maxWidth: 420,
          boxShadow: "0 20px 60px rgba(0,0,0,.25)", overflow: "hidden",
        }}
      >
        <div style={{
          padding: "16px 20px", borderBottom: `1px solid ${t.gray100}`,
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: t.gray900 }}>Create new blog</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: t.gray400 }}>
              A new blog will be created in your Shopify store.
            </p>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", cursor: "pointer",
            color: t.gray400, fontSize: 22, lineHeight: 1, padding: "0 4px",
          }}>x</button>
        </div>

        <div style={{ padding: 20 }}>
          {err && (
            <div style={{
              background: t.red50, border: `1px solid ${t.red300}`,
              borderRadius: 8, padding: "8px 12px", fontSize: 13,
              color: t.red800, marginBottom: 14,
            }}>{err}</div>
          )}
          <Field label="Blog title" hint="required">
            <input
              value={blogTitle}
              onChange={(e) => setBlogTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
              placeholder="e.g. Artist Features, News, Reviews..."
              style={S.input}
              autoFocus
            />
          </Field>
          <p style={{ fontSize: 12, color: t.gray400, marginTop: -8 }}>
            Shopify will auto-generate the handle from the title.
          </p>
        </div>

        <div style={{
          padding: "14px 20px", borderTop: `1px solid ${t.gray100}`,
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>
          <button onClick={onClose} style={S.btnGhost}>Cancel</button>
          <button onClick={handleCreate} disabled={creating}
            style={{ ...S.btnAccent, opacity: creating ? 0.6 : 1, cursor: creating ? "not-allowed" : "pointer" }}>
            {creating ? "Creating..." : "Create blog"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Image upload ─────────────────────────────────────────────────────────────
function ImageUpload({ images, setImages }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const inputRef = useRef();

  const processFiles = (files) => {
    const valid = Array.from(files).filter(
      (f) => f.type.startsWith("image/") && f.size <= 10 * 1024 * 1024
    );
    if (!valid.length) return;
    setUploading(true); setProgress(0);
    let loaded = 0;
    valid.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setImages((prev) => [...prev, { name: file.name, dataUrl: ev.target.result, size: file.size, type: file.type }]);
        loaded++;
        setProgress(Math.round((loaded / valid.length) * 100));
        if (loaded === valid.length) setTimeout(() => { setUploading(false); setProgress(0); }, 600);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (i) => setImages((prev) => prev.filter((_, idx) => idx !== i));
  const setFeatured = (i) => setImages((prev) => {
    const next = [...prev];
    const [item] = next.splice(i, 1);
    return [item, ...next];
  });

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }}
        style={{
          border: `2px dashed ${dragging ? t.accent : t.gray300}`,
          borderRadius: 12, padding: "28px 20px", textAlign: "center",
          cursor: "pointer", background: dragging ? t.accentLight : t.gray50,
          transition: "border-color .2s, background .2s",
        }}
      >
        <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={(e) => { processFiles(e.target.files); e.target.value = ""; }} />
        <div style={{ fontSize: 28, marginBottom: 8 }}>🖼</div>
        <p style={{ fontSize: 14, fontWeight: 600, color: t.gray700, marginBottom: 4 }}>
          Drop images here or <span style={{ color: t.accent }}>browse</span>
        </p>
        <p style={{ fontSize: 12, color: t.gray400 }}>PNG, JPG, GIF, WebP — Max 10 MB each</p>
      </div>

      {uploading && (
        <div style={{ background: t.gray200, borderRadius: 100, height: 4, marginTop: 10, overflow: "hidden" }}>
          <div style={{ height: "100%", background: t.accent, borderRadius: 100, width: `${progress}%`, transition: "width .3s" }} />
        </div>
      )}

      {images.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 12 }}>
          {images.map((img, i) => (
            <div key={i}
              onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)}
              style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 8, overflow: "hidden", border: `1.5px solid ${t.gray200}`, background: t.gray100 }}
            >
              <img src={img.dataUrl} alt={img.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              {i === 0 && (
                <span style={{ position: "absolute", top: 6, left: 6, background: t.accent, color: t.white, fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 100 }}>FEATURED</span>
              )}
              {hoveredIdx === i && (
                <div style={{ position: "absolute", inset: 0, background: "rgba(17,24,39,.6)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  {i !== 0 && (
                    <button onClick={() => setFeatured(i)} style={{ fontSize: 11, background: "rgba(255,255,255,.92)", border: "none", borderRadius: 4, cursor: "pointer", padding: "4px 8px", color: t.gray900, fontWeight: 500, fontFamily: "inherit" }}>Feature</button>
                  )}
                  <button onClick={() => removeImage(i)} style={{ fontSize: 11, background: "rgba(255,255,255,.92)", border: "none", borderRadius: 4, cursor: "pointer", padding: "4px 8px", color: t.red600, fontWeight: 500, fontFamily: "inherit" }}>Remove</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p style={{ marginTop: 8, fontSize: 12, color: t.gray400 }}>
        The first image is set as the article featured image.
      </p>
    </div>
  );
}

// ─── Metafield image picker ───────────────────────────────────────────────────
function MetafieldImagePicker({ label, hint, value, onChange }) {
  const inputRef = useRef();
  const handleFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => onChange({ name: file.name, dataUrl: ev.target.result, size: file.size, type: file.type });
    reader.readAsDataURL(file);
  };
  const clear = (e) => { e.stopPropagation(); onChange(null); };

  return (
    <Field label={label} hint={hint}>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => { handleFile(e.target.files[0]); e.target.value = ""; }} />
      {value ? (
        <div onClick={() => inputRef.current?.click()}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 10px 5px 6px", border: `1.5px solid ${t.gray200}`, borderRadius: 8, background: t.white, cursor: "pointer", maxWidth: "100%", transition: "border-color .15s" }}
          onMouseEnter={(e) => e.currentTarget.style.borderColor = t.accent}
          onMouseLeave={(e) => e.currentTarget.style.borderColor = t.gray200}
        >
          <div style={{ width: 32, height: 32, borderRadius: 5, overflow: "hidden", flexShrink: 0, background: t.gray100, border: `1px solid ${t.gray200}` }}>
            <img src={value.dataUrl} alt={value.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          </div>
          <span style={{ fontSize: 13, color: t.gray700, fontWeight: 500, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value.name}</span>
          <button onClick={clear} title="Remove image"
            style={{ background: "none", border: "none", cursor: "pointer", color: t.gray400, fontSize: 16, lineHeight: 1, padding: "0 2px", marginLeft: 2 }}
            onMouseEnter={(e) => e.currentTarget.style.color = t.red600}
            onMouseLeave={(e) => e.currentTarget.style.color = t.gray400}>x</button>
        </div>
      ) : (
        <div onClick={() => inputRef.current?.click()}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1.5px dashed ${t.gray300}`, borderRadius: 8, background: t.gray50, cursor: "pointer", color: t.gray500, fontSize: 13, transition: "border-color .15s, background .15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.background = t.accentLight; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.gray300; e.currentTarget.style.background = t.gray50; }}
        >
          <span>Add image</span>
        </div>
      )}
    </Field>
  );
}

// ─── Product picker ───────────────────────────────────────────────────────────
function ProductPicker({ products, setProducts }) {
  const [fallbackInput, setFallbackInput] = useState("");
  const [fallbackMode, setFallbackMode] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);

  const openPicker = async () => {
    if (window.shopify?.resourcePicker) {
      try {
        const selected = await window.shopify.resourcePicker({
          type: "product", multiple: true,
          selectionIds: products.map((p) => ({ id: p.id })),
        });
        if (!selected) return;
        setProducts(selected.map((p) => ({
          id: p.id, title: p.title,
          image: p.images?.[0]?.originalSrc || p.featuredImage?.url || null,
        })));
      } catch (err) {
        console.warn("resourcePicker error:", err);
        setFallbackMode(true);
      }
    } else {
      setFallbackMode((v) => !v);
    }
  };

  const removeProduct = (id) => setProducts((prev) => prev.filter((p) => p.id !== id));
  const addFromFallback = () => {
    const gids = fallbackInput.split(",").map((s) => s.trim()).filter((s) => s.startsWith("gid://shopify/Product/"));
    const newOnes = gids.filter((id) => !products.find((p) => p.id === id)).map((id) => ({ id, title: id.split("/").pop(), image: null }));
    if (newOnes.length) setProducts((prev) => [...prev, ...newOnes]);
    setFallbackInput(""); setFallbackMode(false);
  };

  return (
    <div>
      {products.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {products.map((p) => (
            <div key={p.id}
              onMouseEnter={() => setHoveredId(p.id)} onMouseLeave={() => setHoveredId(null)}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px 5px 6px", border: `1.5px solid ${hoveredId === p.id ? t.accent : t.gray200}`, borderRadius: 8, background: t.white, maxWidth: 220, transition: "border-color .15s" }}
            >
              <div style={{ width: 28, height: 28, borderRadius: 5, flexShrink: 0, overflow: "hidden", background: t.gray100, border: `1px solid ${t.gray200}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {p.image ? <img src={p.image} alt={p.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : (
                  <span style={{ fontSize: 10, color: t.gray400 }}>img</span>
                )}
              </div>
              <span style={{ fontSize: 13, color: t.gray700, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{p.title}</span>
              <button onClick={() => removeProduct(p.id)} title="Remove"
                style={{ background: "none", border: "none", cursor: "pointer", color: t.gray400, fontSize: 16, lineHeight: 1, padding: "0 2px", display: "flex", alignItems: "center", flexShrink: 0 }}
                onMouseEnter={(e) => e.currentTarget.style.color = t.red600}
                onMouseLeave={(e) => e.currentTarget.style.color = t.gray400}>x</button>
            </div>
          ))}
        </div>
      )}
      <button onClick={openPicker}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", border: `1.5px dashed ${t.gray300}`, borderRadius: 8, background: t.gray50, color: t.gray600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", transition: "border-color .15s, background .15s" }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.background = t.accentLight; e.currentTarget.style.color = t.accentDark; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.gray300; e.currentTarget.style.background = t.gray50; e.currentTarget.style.color = t.gray500; }}
      >
        + {products.length ? "Add more products" : "Add products"}
      </button>
      {fallbackMode && (
        <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
          <input value={fallbackInput} onChange={(e) => setFallbackInput(e.target.value)}
            placeholder="gid://shopify/Product/123, gid://shopify/Product/456"
            style={{ ...S.input, flex: 1 }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFromFallback(); } }} />
          <button onClick={addFromFallback} style={S.btnSm}>Add</button>
        </div>
      )}
      <p style={{ marginTop: 8, fontSize: 12, color: t.gray400 }}>
        {typeof window !== "undefined" && window.shopify?.resourcePicker
          ? "Opens Shopify product selector."
          : "Paste GIDs manually — resource picker requires an embedded app context."}
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { shop, blogs: initialBlogs } = useLoaderData();

  const [blogs, setBlogs] = useState(initialBlogs ?? []);
  const [blogId, setBlogId] = useState(initialBlogs?.[0]?.id ?? "");
  const [showCreateBlog, setShowCreateBlog] = useState(false);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [images, setImages] = useState([]);
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState([]);
  const [published, setPublished] = useState(false);
  const [affiliation, setAffiliation] = useState("");
  const [cymbalSetup, setCymbalSetup] = useState("");
  const [q1, setQ1] = useState(""); const [q2, setQ2] = useState("");
  const [q3, setQ3] = useState(""); const [q4, setQ4] = useState("");
  const [cymbalSetupImage, setCymbalSetupImage] = useState(null);
  const [featuredBannerImage, setFeaturedBannerImage] = useState(null);
  const [goToProducts, setGoToProducts] = useState([]);
  const [activeTab, setActiveTab] = useState("content");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [createdArticle, setCreatedArticle] = useState(null);

  const fetcher = useFetcher();
  const imageFetcher = useFetcher();
  const uploadFetcher = useFetcher();
  const uploadResolveRef = useRef(null);
  const uploadKeyRef = useRef(0); // incremented each call so stale data is ignored

  const handleBlogCreated = (newBlog) => {
    setBlogs((prev) => [...prev, newBlog]);
    setBlogId(newBlog.id);
    setTitle(newBlog.title);
    setStatus({ type: "success", message: `Blog "${newBlog.title}" created and selected!` });
  };

  // ── Upload a single metafield image via uploadFetcher → returns GID or null ──
  // Raw fetch() hits app-bridge (405) or the layout route (no action).
  // useFetcher() is the only reliable way to POST to this route's action from
  // inside an embedded Shopify app. We wrap it in a Promise keyed by a counter
  // so stale .data from a previous call is never mistaken for the current one.
  function uploadShopifyFile(imageObj) {
    if (!imageObj) return Promise.resolve(null);
    const attachment = imageObj.dataUrl.split(",")[1];
    const mimeType = imageObj.type || imageObj.dataUrl.split(";")[0].split(":")[1];
    const fileSize = String(Math.ceil((attachment.length * 3) / 4));
    const key = ++uploadKeyRef.current;

    return new Promise((resolve) => {
      uploadResolveRef.current = { resolve, key };
      uploadFetcher.submit(
        { intent: "uploadFile", filename: imageObj.name, mimeType, attachment, fileSize },
        { method: "post" }
      );
    });
  }

  // Resolve the pending promise when uploadFetcher returns fresh data
  useEffect(() => {
    if (!uploadFetcher.data) return;
    if (!uploadResolveRef.current) return;
    // Only resolve if the fetcher is idle (submission complete), not still loading
    if (uploadFetcher.state !== "idle") return;
    const { resolve } = uploadResolveRef.current;
    uploadResolveRef.current = null;
    if (uploadFetcher.data?.error) {
      console.error("[uploadShopifyFile] server error:", uploadFetcher.data.error);
      resolve(null);
    } else {
      console.log("[uploadShopifyFile] success, GID:", uploadFetcher.data?.gid);
      resolve(uploadFetcher.data?.gid ?? null);
    }
  }, [uploadFetcher.data, uploadFetcher.state]);

  function buildMetafields(cymbalGid = null, bannerGid = null) {
    const raw = [
      { namespace: "custom", key: "affiliation",  value: affiliation, type: "single_line_text_field" },
      { namespace: "custom", key: "cymbal_setup", value: cymbalSetup, type: "multi_line_text_field"  },
      { namespace: "custom", key: "question_1",   value: q1,          type: "single_line_text_field" },
      { namespace: "custom", key: "question_2",   value: q2,          type: "single_line_text_field" },
      { namespace: "custom", key: "question_3",   value: q3,          type: "single_line_text_field" },
      { namespace: "custom", key: "question_4",   value: q4,          type: "single_line_text_field" },
      // Only include file_reference if we have a real Shopify GID
      cymbalGid ? { namespace: "custom", key: "cymbal_setup_image",    value: cymbalGid, type: "file_reference" } : null,
      bannerGid ? { namespace: "custom", key: "featured_banner_image", value: bannerGid, type: "file_reference" } : null,
    ].filter(Boolean);

    if (goToProducts.length) {
      raw.push({
        namespace: "custom",
        key: "go_to_products",
        value: JSON.stringify(goToProducts.map((p) => p.id)),
        type: "list.product_reference",
      });
    }

    return raw.filter((f) => f.value && String(f.value).trim() !== "");
  }

  // ── Main save handler — now async to upload files first ──
  async function handlePost() {
    if (!blogId) {
      setStatus({ type: "error", message: "Please select a blog or create a new one first." });
      return;
    }
    setSaving(true);

    // Step 1: Upload metafield images to Shopify Files if present
    let cymbalGid = null;
    let bannerGid = null;

    if (cymbalSetupImage || featuredBannerImage) {
      // uploadFetcher can only handle one submission at a time → upload sequentially
      if (cymbalSetupImage) {
        setStatus({ type: "loading", message: "Uploading cymbal setup image..." });
        cymbalGid = await uploadShopifyFile(cymbalSetupImage);
        if (!cymbalGid) {
          setStatus({ type: "error", message: "Failed to upload cymbal setup image. Check console for details." });
          setSaving(false);
          return;
        }
      }
      if (featuredBannerImage) {
        setStatus({ type: "loading", message: "Uploading featured banner image..." });
        bannerGid = await uploadShopifyFile(featuredBannerImage);
        if (!bannerGid) {
          setStatus({ type: "error", message: "Failed to upload featured banner image. Check console for details." });
          setSaving(false);
          return;
        }
      }
    }

    // Step 2: Build article variables with real GIDs
    setStatus({ type: "loading", message: "Creating article..." });
    const metafields = buildMetafields(cymbalGid, bannerGid);

    const article = { blogId, title: title || "Untitled", isPublished: published };
    if (content && content.trim())  article.body       = content;
    if (author && author.trim())    article.author     = { name: author.trim() };
    if (tags.length)                article.tags       = tags;
    if (metafields.length)          article.metafields = metafields;

    fetcher.submit(
      { query: CREATE_ARTICLE_MUTATION, variables: JSON.stringify({ article }) },
      { method: "post" }
    );
  }

  function handleDiscard() {
    if (!window.confirm("Discard all changes?")) return;
    setTitle(""); setContent(""); setImages([]);
    setBlogId(blogs?.[0]?.id ?? "");
    setAuthor(""); setTags([]);
    setPublished(false);
    setAffiliation(""); setCymbalSetup("");
    setCymbalSetupImage(null); setFeaturedBannerImage(null);
    setQ1(""); setQ2(""); setQ3(""); setQ4("");
    setGoToProducts([]); setStatus(null); setCreatedArticle(null);
  }

  // ── Article create result → upload article featured image via REST ──
  useEffect(() => {
    if (!fetcher.data) return;
    const result = fetcher.data?.data?.articleCreate;
    if (result?.userErrors?.length) {
      setStatus({
        type: "error",
        message: result.userErrors.map((e) => `[${e.field?.join(".") ?? "unknown"}] ${e.message}`).join(" — "),
      });
      setSaving(false);
    } else if (result?.article) {
      const savedMeta = result.article?.metafields?.edges ?? [];
      console.log("Metafields saved:", savedMeta.length, savedMeta.map((e) => e.node.key));
      setCreatedArticle({ ...result.article, metafieldCount: savedMeta.length });

      if (images.length > 0) {
        setStatus({ type: "loading", message: "Article saved! Uploading featured image..." });
        const featured = images[0];
        const attachment = featured.dataUrl.split(",")[1];
        imageFetcher.submit(
          {
            intent: "addImage",
            articleId: result.article.id,
            blogId,
            attachment,
            filename: featured.name,
          },
          { method: "post" }
        );
      } else {
        setStatus({ type: "success", message: "Article created successfully!" });
        setSaving(false);
      }
    } else if (!fetcher.data?.data?.blogCreate) {
      setStatus({ type: "error", message: fetcher.data?.error ?? JSON.stringify(fetcher.data) });
      setSaving(false);
    }
  }, [fetcher.data]);

  // ── Featured image upload result ──
  useEffect(() => {
    if (!imageFetcher.data) return;
    if (imageFetcher.data.error) {
      setStatus({ type: "error", message: "Article saved but featured image failed: " + JSON.stringify(imageFetcher.data.error) });
    } else {
      setStatus({ type: "success", message: "Article and featured image saved successfully!" });
    }
    setSaving(false);
  }, [imageFetcher.data]);

  const tabs = [{ id: "content", label: "Content" }, { id: "metafields", label: "Metafields" }];
  const badge = (label) => (
    <span style={{ fontSize: 10, fontWeight: 700, background: t.accent, color: t.white, borderRadius: 100, padding: "2px 8px", letterSpacing: "0.06em" }}>{label}</span>
  );

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: t.gray50, minHeight: "100vh", padding: "24px 20px" }}>

      {showCreateBlog && (
        <CreateBlogModal onClose={() => setShowCreateBlog(false)} onCreated={handleBlogCreated} />
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 12 }}>
        <div>
          <p style={{ fontSize: 11, color: t.gray400, marginBottom: 4 }}>
            Content / Blog posts / <span style={{ color: t.gray900 }}>New article</span>
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: t.gray900, margin: 0 }}>Create blog post</h1>
            {badge("GRAPHQL")}
          </div>
          <p style={{ fontSize: 12, color: t.gray400, marginTop: 4 }}>
            Store: <span style={{ color: t.gray600, fontWeight: 500 }}>{shop}</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          <button
            onClick={() => setShowCreateBlog(true)}
            style={{
              fontSize: 13, fontWeight: 600, color: t.accent,
              background: t.accentLight, border: "1px solid #c4b5fd",
              borderRadius: 8, padding: "7px 14px", cursor: "pointer",
              fontFamily: "inherit", transition: "background .15s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = "#ddd6fe"}
            onMouseLeave={(e) => e.currentTarget.style.background = t.accentLight}
          >
            + New blog
          </button>
          <button onClick={handleDiscard} style={S.btnGhost}>Discard</button>
          <button
            onClick={handlePost}
            disabled={saving}
            style={{ ...S.btnPrimary, opacity: saving ? 0.6 : 1, cursor: saving ? "not-allowed" : "pointer" }}
          >
            {saving ? "Saving..." : "Save article"}
          </button>
        </div>
      </div>

      <StatusBanner status={status} />

      {createdArticle && (
        <div style={{ background: t.green50, border: `1px solid ${t.green300}`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: t.green800 }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Article created</strong>
          ID: <code style={{ fontFamily: "monospace", background: t.green100, padding: "1px 6px", borderRadius: 4 }}>{createdArticle.id}</code>{" "}
          Handle: <code style={{ fontFamily: "monospace", background: t.green100, padding: "1px 6px", borderRadius: 4 }}>{createdArticle.handle}</code>
          {createdArticle.blog && (
            <> — Blog: <code style={{ fontFamily: "monospace", background: t.green100, padding: "1px 6px", borderRadius: 4 }}>{createdArticle.blog.title}</code></>
          )}
          {createdArticle.metafieldCount > 0 && (
            <> — <span>✓ {createdArticle.metafieldCount} metafield{createdArticle.metafieldCount > 1 ? "s" : ""} saved</span></>
          )}
          {createdArticle.metafieldCount === 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: t.amber800, background: t.amber50, border: `1px solid ${t.amber300}`, borderRadius: 6, padding: "4px 10px" }}>
              ⚠ Metafields were not saved — check that metafield definitions exist in Shopify Admin → Settings → Custom data → Articles
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `2px solid ${t.gray200}`, marginBottom: 20 }}>
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: "10px 20px", fontSize: 14, border: "none", cursor: "pointer",
            background: "transparent", fontFamily: "inherit",
            color: activeTab === tab.id ? t.gray900 : t.gray500,
            borderBottom: activeTab === tab.id ? `2px solid ${t.accent}` : "2px solid transparent",
            fontWeight: activeTab === tab.id ? 600 : 400, marginBottom: -2, transition: "color .15s",
          }}>{tab.label}</button>
        ))}
      </div>

      {/* Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 272px", gap: 16, alignItems: "start" }}>

        {/* Main column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {activeTab === "content" && (
            <>
              <div style={S.card}>
                <div style={S.cardBody}>
                  <Field label="Title">
                    <input value={title} onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g. Mimmo Di Cicco - Artist" style={S.input} />
                  </Field>
                  <Field label="Body (HTML)" hint="Full HTML supported">
                    <textarea value={content} onChange={(e) => setContent(e.target.value)}
                      rows={14} placeholder="<p>Artist bio or article content...</p>" style={S.textarea} />
                  </Field>
                </div>
              </div>
              <div style={S.card}>
                <div style={S.cardHeader}>
                  <span style={S.cardTitle}>Images</span>
                  <span style={{ fontSize: 12, color: t.gray400 }}>
                    {images.length === 0 ? "No images added" : `${images.length} image${images.length > 1 ? "s" : ""}`}
                  </span>
                </div>
                <div style={S.cardBody}><ImageUpload images={images} setImages={setImages} /></div>
              </div>
            </>
          )}

          {activeTab === "metafields" && (
            <div style={S.card}>
              <div style={S.cardBody}>
                <div style={S.sectionEyebrow}><span>Artist and Setup</span>{badge("GraphQL")}</div>
                <Field label="Affiliation">
                  <input value={affiliation} onChange={(e) => setAffiliation(e.target.value)}
                    placeholder="Independent, Zildjian, Meinl..." style={S.input} />
                </Field>
                <Field label="Cymbal setup">
                  <textarea value={cymbalSetup} onChange={(e) => setCymbalSetup(e.target.value)}
                    rows={3} placeholder="15 inch Special Dry K Custom Hihat..." style={S.textarea} />
                </Field>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <MetafieldImagePicker label="Cymbal setup image" hint="file" value={cymbalSetupImage} onChange={setCymbalSetupImage} />
                  <MetafieldImagePicker label="Featured banner image" hint="file" value={featuredBannerImage} onChange={setFeaturedBannerImage} />
                </div>
                <p style={{ fontSize: 12, color: t.gray400, marginTop: -8, marginBottom: 16 }}>
                  Images are uploaded to Shopify Files and stored as file references.
                </p>
                <hr style={{ border: "none", borderTop: `1px solid ${t.gray100}`, margin: "16px 0" }} />
                <div style={S.sectionEyebrow}>Q and A Answers</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <Field label="Question 1"><input value={q1} onChange={(e) => setQ1(e.target.value)} placeholder="My Son, Love, Passion..." style={S.input} /></Field>
                  <Field label="Question 2"><input value={q2} onChange={(e) => setQ2(e.target.value)} placeholder="Experiment with new styles..." style={S.input} /></Field>
                  <Field label="Question 3"><input value={q3} onChange={(e) => setQ3(e.target.value)} placeholder="HH 15 inch Special Dry K Custom..." style={S.input} /></Field>
                  <Field label="Question 4" hint="optional"><input value={q4} onChange={(e) => setQ4(e.target.value)} placeholder="Optional" style={S.input} /></Field>
                </div>
                <hr style={{ border: "none", borderTop: `1px solid ${t.gray100}`, margin: "16px 0" }} />
                <div style={S.sectionEyebrow}>Products</div>
                <Field label="Go-to products" desc="Products linked to this article. Stored as Shopify product GID references.">
                  <ProductPicker products={goToProducts} setProducts={setGoToProducts} />
                </Field>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Blog selector */}
          <div style={S.card}>
            <div style={S.cardHeader}><span style={S.cardTitle}>Blog</span></div>
            <div style={S.cardBody}>
              <Field label="Target blog">
                <select value={blogId} onChange={(e) => setBlogId(e.target.value)} style={S.select}>
                  {blogs.map((b) => (
                    <option key={b.id} value={b.id}>{b.title}</option>
                  ))}
                  {blogs.length === 0 && <option value="">No blogs — create one above</option>}
                </select>
              </Field>
            </div>
          </div>

          <div style={S.card}>
            <div style={S.cardHeader}><span style={S.cardTitle}>Organization</span></div>
            <div style={S.cardBody}>
              <Field label="Author">
                <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Jasper Molnar" style={S.input} />
              </Field>
              <Field label="Tags"><TagInput tags={tags} setTags={setTags} /></Field>
            </div>
          </div>

          <div style={S.card}>
            <div style={S.cardHeader}><span style={S.cardTitle}>Publishing</span></div>
            <div style={S.cardBody}>
              <Field label="Visibility">
                <select value={published ? "true" : "false"} onChange={(e) => setPublished(e.target.value === "true")} style={S.select}>
                  <option value="false">Draft</option>
                  <option value="true">Published</option>
                </select>
              </Field>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}