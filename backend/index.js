import dns from "dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import reviewsRouter from "./routes/reviews.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 8001;

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "100mb" }));
app.use(express.static("public"));

app.use("/api", reviewsRouter);

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);