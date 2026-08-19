import '@shopify/ui-extensions/preact';
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";

export default async () => { 
  render(<Extension />, document.body);
};

async function fetchProductRating(productId) {
  try {
    const { data } = await shopify.query(
      `query ProductRating($id: ID!) {
        product(id: $id) {
          featuredImage {
            url
            altText
          }
          rating: metafield(namespace: "reviews", key: "rating") {
            value
          }
          ratingCount: metafield(namespace: "reviews", key: "rating_count") {
            value
          }
        }
      }`,
      { variables: { id: productId } }
    );

    const product = data?.product;
    if (!product) return null;

    let rating = null;
    if (product.rating?.value) {
      try {
        rating = Math.round(JSON.parse(product.rating.value).value);
      } catch {
        rating = Math.round(Number(product.rating.value));
      }
    }

    return {
      imageUrl: product.featuredImage?.url ?? null,
      imageAlt: product.featuredImage?.altText ?? "",
      rating,
      ratingCount: product.ratingCount?.value
        ? Number(product.ratingCount.value)
        : null,
    };
  } catch (err) {
    console.log("[review-block] rating fetch failed:", err.message || err);
    return null;
  }
}

async function fetchRealReview(productId) {
  try {
    const numericId = productId.split("/").pop();
    const res = await fetch(
      `https://a195-2401-4900-1c2a-6e8a-65a2-eafb-d78b-5948.ngrok-free.app/api/reviews/${numericId}?shop=sahil-app-testing.myshopify.com`,
      {
        headers: {
          "ngrok-skip-browser-warning": "true",
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.review || null;
  } catch (err) {
    console.log("[review-block] backend fetch failed:", err.message);
    return null;
  }
}

async function fetchProductReviewData(productId) {
  const [ratingInfo, review] = await Promise.all([
    fetchProductRating(productId),
    fetchRealReview(productId),
  ]);

  return {
    imageUrl: ratingInfo?.imageUrl ?? null,
    imageAlt: ratingInfo?.imageAlt ?? "",
    rating: ratingInfo?.rating ?? null,
    ratingCount: ratingInfo?.ratingCount ?? null,
    review,
  };
}

function StarRating({ rating }) {
  if (rating == null) return null;
  return <s-text>{"★".repeat(rating) + "☆".repeat(5 - rating)}</s-text>;
}

function ReviewCard({ line, info }) {
  const [expanded, setExpanded] = useState(false);

  if (!info?.review?.body) return null;

  const review = info.review;
  const isLong = review.body.length > 140;
  const displayText =
    isLong && !expanded ? review.body.slice(0, 140).trim() + "…" : review.body;

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-grid gridTemplateColumns="56px 1fr" gap="base">
        {info?.imageUrl && (
          <s-image src={info.imageUrl} alt={info.imageAlt} borderRadius="base" />
        )}
        <s-stack gap="tight">
          <s-text type="strong">{line.merchandise.title}</s-text>

          <s-stack direction="inline" gap="extra-tight" blockAlignment="center">
            <StarRating rating={review.rating ?? info.rating} />
            <s-text tone="subdued">
              {review.reviewer}
              {review.date
                ? ` · ${new Date(review.date).toLocaleDateString()}`
                : ""}
            </s-text>
          </s-stack>

          {review.title && <s-text type="strong">{review.title}</s-text>}
          <s-text tone="subdued">"{displayText}"</s-text>

          {isLong && (
            <s-clickable onClick={() => setExpanded((v) => !v)}>
              <s-text tone="interactive">
                {expanded ? "See less" : "See more"}
              </s-text>
            </s-clickable>
          )}

          {info?.ratingCount != null && (
            <s-text tone="subdued">({info.ratingCount} reviews)</s-text>
          )}
        </s-stack>
      </s-grid>
    </s-box>
  );
}

function Extension() {
  const lines = shopify.lines?.value ?? [];
  const [reviewData, setReviewData] = useState({});

  useEffect(() => {
    lines.forEach(async (line) => {
      const productId = line.merchandise?.product?.id;
      if (!productId || reviewData[productId] !== undefined) return;
      const result = await fetchProductReviewData(productId);
      setReviewData((prev) => ({ ...prev, [productId]: result }));
    });
  }, [lines]);

  if (!lines.length) return null;

  const cardsWithReview = lines.filter(
    (line) => reviewData[line.merchandise?.product?.id]?.review?.body
  );

  if (!cardsWithReview.length) return null;

  return (
    <s-stack gap="base" padding="base">
      <s-heading>Reviews of Items in Your Cart</s-heading>
      {cardsWithReview.map((line) => {
        const productId = line.merchandise?.product?.id;
        return (
          <ReviewCard key={line.id} line={line} info={reviewData[productId]} />
        );
      })}
    </s-stack>
  );
}