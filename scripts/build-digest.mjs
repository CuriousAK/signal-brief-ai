// Builds digest.json: fetches the latest posts from each source, asks Claude to
// write a founder-facing verdict + takeaways, and writes the result to disk.
//
// Runs in GitHub Actions on a schedule. Requires ANTHROPIC_API_KEY as a repo secret.
//
// GUARDRAIL: only real, fetched article URLs are ever included. Claude is asked
// to summarize supplied text only, and never to invent a link or a fact.

import fs from "node:fs/promises";
import path from "node:path";
import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";

// --- Config -----------------------------------------------------------------
// VERIFY these feed URLs on first run. Substack custom domains change; if a
// source reports "no new post" for weeks, the feed URL is probably wrong.
const SOURCES = [
  { name: "One Useful Thing", author: "Ethan Mollick",     feed: "https://www.oneusefulthing.org/feed" },
  { name: "Ahead of AI",      author: "Sebastian Raschka", feed: "https://magazine.sebastianraschka.com/feed" },
  { name: "Latent Space",     author: "swyx",              feed: "https://www.latent.space/feed" },
  { name: "Import AI",        author: "Jack Clark",        feed: "https://importai.net/feed" },
  { name: "Interconnects",    author: "Nathan Lambert",    feed: "https://www.interconnects.ai/feed" }
];

const LOOKBACK_DAYS = 7;
const MODEL = "claude-sonnet-5"; // swap to "claude-haiku-4-5-20251001" for lower cost
const OUT = path.resolve("digest.json");

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const parser = new Parser({ timeout: 20000 });

// --- Helpers ----------------------------------------------------------------
function withinLookback(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  const cutoff = Date.now() - LOOKBACK_DAYS * 864e5;
  return d.getTime() >= cutoff;
}

function stripHtml(html = "") {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function analyze(source, author, title, excerpt) {
  const prompt = `You are a fractional CTO briefing a NON-TECHNICAL health-tech founder.
Below is a post. Judge only what is in the text. Do not invent facts, links, or numbers.

SOURCE: ${source} by ${author}
TITLE: ${title}
EXCERPT: ${excerpt}

Return ONLY valid JSON, no prose, no code fences:
{
  "verdict": "BUILD-RELEVANT" | "WATCH" | "SKIP",
  "takeaways": ["2 to 3 short sentences, each a concrete implication for what a health-tech founder should build, watch, or ignore"]
}
Rules:
- BUILD-RELEVANT = changes a build decision now. WATCH = worth tracking. SKIP = no action.
- Plain language a non-technical founder understands. No hype. No em dashes.
- If the excerpt is too thin to judge, use WATCH and say so honestly.`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }]
  });

  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  const clean = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed.takeaways)) parsed.takeaways = [String(parsed.takeaways || "")];
    return parsed;
  } catch {
    return { verdict: "WATCH", takeaways: ["Could not parse an analysis for this item. Read the original."] };
  }
}

// --- Main -------------------------------------------------------------------
async function main() {
  const items = [];
  const misses = [];

  for (const s of SOURCES) {
    try {
      const feed = await parser.parseURL(s.feed);
      const fresh = (feed.items || [])
        .filter(i => withinLookback(i.isoDate || i.pubDate))
        .slice(0, 1); // newest post per source; raise to 2 if you want more volume

      if (fresh.length === 0) {
        misses.push({ source: `${s.name} (${s.author})`, reason: "No new post in the last 7 days" });
        continue;
      }

      for (const post of fresh) {
        const title = post.title || "(untitled)";
        const url = post.link || "";           // real fetched URL only
        if (!url) { misses.push({ source: s.name, reason: "Post had no link, skipped" }); continue; }
        const excerpt = stripHtml(post.contentSnippet || post.content || post.summary || "").slice(0, 1800);
        const analysis = await analyze(s.name, s.author, title, excerpt);
        items.push({
          source: s.name,
          author: s.author,
          date: (post.isoDate || post.pubDate || new Date().toISOString()).slice(0, 10),
          title,
          url,
          verdict: analysis.verdict || "WATCH",
          takeaways: analysis.takeaways
        });
      }
    } catch (err) {
      misses.push({ source: `${s.name} (${s.author})`, reason: "Feed unreachable, check the feed URL" });
      console.error(`Feed error for ${s.name}:`, err.message);
    }
  }

  // Sort BUILD-RELEVANT first, then WATCH, then SKIP.
  const rank = { "BUILD-RELEVANT": 0, WATCH: 1, SKIP: 2 };
  items.sort((a, b) => (rank[a.verdict] ?? 1) - (rank[b.verdict] ?? 1));

  // Increment issue number from the previous digest if present.
  let issue = 1;
  try {
    const prev = JSON.parse(await fs.readFile(OUT, "utf8"));
    if (Number.isFinite(prev.issue)) issue = prev.issue + 1;
  } catch { /* first run */ }

  const digest = { issue, generated_at: new Date().toISOString(), items, misses };
  await fs.writeFile(OUT, JSON.stringify(digest, null, 2) + "\n");
  console.log(`Wrote ${OUT}: issue ${issue}, ${items.length} items, ${misses.length} misses.`);
}

main().catch(e => { console.error(e); process.exit(1); });
