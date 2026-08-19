import express from "express";

const router = express.Router();

router.get("/reviews/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const { shop } = req.query;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const judgeMeRes = await fetch(
      `https://judge.me/api/v1/reviews?shop_domain=${encodeURIComponent(shop)}&api_token=${process.env.JUDGEME_API_TOKEN}&product_external_id=${productId}&per_page=20`,
    );

    if (!judgeMeRes.ok) {
      const errorBody = await judgeMeRes.text();
      console.error("Judge.me API error:", judgeMeRes.status, errorBody);
      return res.json({ review: null });
    }

    const data = await judgeMeRes.json();
    const allReviews = data.reviews || [];

    console.log(
      "[reviews] fetched",
      allReviews.length,
      "reviews for productId:",
      productId,
    );

    if (allReviews.length > 0) {
      console.log(
        "[reviews] DEBUG first review full object:",
        JSON.stringify(allReviews[0], null, 2),
      );
    }

    const matchedReview = allReviews.find((r) => {
      const reviewProductId = String(
        r.product_external_id || r.product?.external_id || r.product_id || "",
      );
      return reviewProductId === String(productId);
    });

    if (!matchedReview) {
      console.log("[reviews] no review matched exact product, returning null");
      return res.json({ review: null });
    }

    return res.json({
      review: {
        reviewer: matchedReview.reviewer?.name || "Customer",
        date: matchedReview.created_at || null,
        title: matchedReview.title || "",
        body: matchedReview.body || "",
        rating: matchedReview.rating || null,
      },
    });
  } catch (err) {
    console.error("Judge.me review fetch error:", err.message);
    return res.status(500).json({ review: null });
  }
});

export default router;
