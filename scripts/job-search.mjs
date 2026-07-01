#!/usr/bin/env node
// Autonomous daily job-search digest generator.
//
// Fetches recent remote postings from free public job APIs, filters them to
// the last N hours + remote-only + salary >= threshold, scores them as
// "stretch" matches against resume.yaml, and renders a Markdown digest.
//
// Usage:
//   node scripts/job-search.mjs [--dry-run] [--since-hours=48] [--send-email]
//
//   --dry-run       Print the digest to stdout instead of writing digest/*.md.
//                    Also skips sending email unless --send-email is passed too.
//   --since-hours=N Override the recency window (default 48). Useful locally
//                    to avoid an empty digest when testing outside real windows.
//   --send-email    Force an email attempt even in --dry-run mode (for testing
//                    real credentials without committing a digest file).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { trySendEmail } from "./send-email.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE_SEND_EMAIL = args.includes("--send-email");
const sinceHoursArg = args.find((a) => a.startsWith("--since-hours="));
const SINCE_HOURS = sinceHoursArg ? Number(sinceHoursArg.split("=")[1]) : 48;

const SENIORITY_RANK = ["junior", "mid", "senior", "staff", "principal"];

function loadYamlLite(text) {
  // Minimal YAML subset parser: top-level `key: value` and `key:` + `- item`
  // list entries. Avoids a third-party dependency for a simple flat config.
  const lines = text.split("\n");
  const result = {};
  let currentKey = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s*-\s*(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(stripQuotes(listMatch[1].trim()));
      continue;
    }
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      currentKey = key;
      const value = rawValue.trim();
      if (value === "") {
        result[key] = []; // will be filled by subsequent list items
      } else if (value === "true" || value === "false") {
        result[key] = value === "true";
      } else if (!Number.isNaN(Number(value)) && value !== "") {
        result[key] = Number(value);
      } else {
        result[key] = stripQuotes(value);
      }
    }
  }
  return result;
}

function stripQuotes(s) {
  return s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function loadResume() {
  const path = join(REPO_ROOT, "resume.yaml");
  const resume = loadYamlLite(readFileSync(path, "utf8"));
  const sentinelFields = Object.entries(resume).filter(([, v]) =>
    Array.isArray(v)
      ? v.some((item) => String(item).includes("REPLACE_ME"))
      : String(v).includes("REPLACE_ME")
  );
  return { resume, isPlaceholder: sentinelFields.length > 0 };
}

function loadConfig() {
  const path = join(REPO_ROOT, "config", "job-search-config.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function inferSeniorityRung(title, config) {
  const lower = ` ${title.toLowerCase()} `;
  // Check from most senior to least so "Staff Software Engineer" doesn't
  // accidentally match a lower rung's looser keyword first.
  for (let i = config.seniority_ladder.length - 1; i >= 0; i--) {
    const rung = config.seniority_ladder[i];
    if (rung.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return rung.level;
    }
  }
  return null;
}

function rankOf(level) {
  return SENIORITY_RANK.indexOf(level);
}

function parseSalaryFromText(text) {
  if (!text) return null;
  const patterns = [
    /\$\s?(\d{3})[,]?(\d{3})\b/, // $175,000 or $175000
    /\$\s?(1[7-9]\d|[2-9]\d{2})\s?k\b/i, // $175k .. $999k
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      if (m[2] !== undefined) return Number(m[1] + m[2]);
      return Number(m[1]) * 1000;
    }
  }
  return null;
}

async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[job-search] fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.warn(`[job-search] fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function fetchRemotive(config) {
  if (!config.sources.remotive) return [];
  const data = await fetchJson("https://remotive.com/api/remote-jobs");
  if (!data?.jobs) return [];
  return data.jobs.map((j) => ({
    title: j.title,
    company: j.company_name,
    url: j.url,
    tags: j.tags || [],
    description: j.description || "",
    salary_min: null,
    salary_max: null,
    salary_text: j.salary || "",
    posted_at: j.publication_date,
    source: "Remotive",
    remote: true,
  }));
}

async function fetchRemoteOK(config) {
  if (!config.sources.remoteok) return [];
  const data = await fetchJson("https://remoteok.com/api");
  if (!Array.isArray(data)) return [];
  return data
    .filter((j) => j && j.id) // first element is metadata, not a job
    .map((j) => ({
      title: j.position || j.title,
      company: j.company,
      url: j.url,
      tags: j.tags || [],
      description: j.description || "",
      salary_min: j.salary_min || null,
      salary_max: j.salary_max || null,
      salary_text: "",
      posted_at: j.date,
      source: "RemoteOK",
      remote: true,
    }));
}

async function fetchArbeitnow(config) {
  if (!config.sources.arbeitnow) return [];
  const data = await fetchJson("https://www.arbeitnow.com/api/job-board-api");
  if (!data?.data) return [];
  return data.data
    .filter((j) => j.remote === true)
    .map((j) => ({
      title: j.title,
      company: j.company_name,
      url: j.url,
      tags: j.tags || [],
      description: j.description || "",
      salary_min: null,
      salary_max: null,
      salary_text: "",
      posted_at: j.created_at ? j.created_at * 1000 : null,
      source: "Arbeitnow",
      remote: true,
    }));
}

function parseRss(xml) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
  for (const block of itemBlocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";
    };
    items.push({
      title: get("title"),
      link: get("link"),
      description: get("description"),
      pubDate: get("pubDate"),
    });
  }
  return items;
}

async function fetchWeWorkRemotely(config) {
  if (!config.sources.weworkremotely) return [];
  const xml = await fetchText(
    "https://weworkremotely.com/categories/remote-programming-jobs.rss"
  );
  if (!xml) return [];
  const items = parseRss(xml);
  return items.map((it) => {
    const titleParts = it.title.split(":");
    const company = titleParts.length > 1 ? titleParts[0].trim() : "";
    const title = titleParts.length > 1 ? titleParts.slice(1).join(":").trim() : it.title;
    return {
      title,
      company,
      url: it.link,
      tags: [],
      description: it.description,
      salary_min: null,
      salary_max: null,
      salary_text: "",
      posted_at: it.pubDate ? new Date(it.pubDate).getTime() : null,
      source: "WeWorkRemotely",
      remote: true,
    };
  });
}

function withinRecency(posting, sinceHours) {
  if (!posting.posted_at) return false;
  const postedMs =
    typeof posting.posted_at === "number" ? posting.posted_at : new Date(posting.posted_at).getTime();
  if (Number.isNaN(postedMs)) return false;
  return Date.now() - postedMs <= sinceHours * 3600 * 1000;
}

function dedupeKey(posting) {
  return `${posting.title}`.toLowerCase().trim() + "|" + `${posting.company}`.toLowerCase().trim();
}

function scorePosting(posting, resume, config) {
  const rung = inferSeniorityRung(posting.title, config);
  const currentRank = rankOf(resume.seniority_level);
  const targetRank = rankOf(resume.target_stretch_level);
  const postingRank = rung ? rankOf(rung) : -1;

  const isStretch = postingRank === targetRank;
  const isLongShot = postingRank > targetRank && postingRank !== -1;
  const isSameLevel = postingRank === currentRank;

  const haystack = `${posting.title} ${posting.tags.join(" ")} ${posting.description}`.toLowerCase();
  const skills = Array.isArray(resume.skills) ? resume.skills : [];
  const matchedSkills = skills.filter(
    (s) => s && !String(s).includes("REPLACE_ME") && haystack.includes(String(s).toLowerCase())
  );

  let salaryConfidence = 0;
  let salaryMax = posting.salary_max;
  let salaryAnnotation = "";
  if (posting.salary_min || posting.salary_max) {
    salaryMax = posting.salary_max || posting.salary_min;
    salaryConfidence = 2;
  } else {
    const parsed = parseSalaryFromText(`${posting.salary_text} ${posting.description}`);
    if (parsed) {
      salaryMax = parsed;
      salaryConfidence = 1;
      salaryAnnotation = " (parsed from description)";
    }
  }

  const meetsSalary = salaryMax !== null && salaryMax >= (resume.min_total_comp_usd || 175000);

  const recencyBonus = withinRecency(posting, 24) ? 1 : 0;
  const score =
    (isStretch ? 3 : isLongShot ? 1 : isSameLevel ? 0.5 : 0) +
    matchedSkills.length * 1.5 +
    salaryConfidence +
    recencyBonus;

  // Bucket priority: only postings at the stretch/long-shot rung are kept at
  // all. Among those, low skill overlap is flagged as "adjacent" regardless
  // of salary (low confidence either way); otherwise salary confidence
  // decides strong vs. likely; a posting with disclosed salary below the
  // threshold is dropped entirely.
  let bucket = null;
  if (isStretch || isLongShot) {
    if (matchedSkills.length === 0) {
      bucket = "adjacent";
    } else if (meetsSalary) {
      bucket = "strong";
    } else if (salaryMax === null) {
      bucket = "likely";
    }
  }

  return {
    ...posting,
    rung,
    isStretch,
    isLongShot,
    matchedSkills,
    salaryMax,
    salaryAnnotation,
    meetsSalary,
    score,
    bucket,
  };
}

function formatDigest(buckets, stats, resume, isPlaceholder) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# Job Search Digest — ${today}`);
  lines.push("");
  lines.push(
    `Generated: ${new Date().toISOString()}. Window: last ${SINCE_HOURS}h. Sources: Remotive, RemoteOK, Arbeitnow, WeWorkRemotely.`
  );
  lines.push(`Email status: ${stats.emailStatus}`);
  lines.push("");
  if (isPlaceholder) {
    lines.push(
      "> ⚠️ **resume.yaml still contains REPLACE_ME placeholders.** Matching below is unreliable until you fill in your real skills/experience."
    );
    lines.push("");
  }

  const sections = [
    ["strong", "Strong Matches (confirmed salary >= threshold, stretch-level, remote)"],
    ["likely", "Likely Matches (salary not disclosed, other criteria fit)"],
    ["adjacent", "Adjacent-Domain Stretch (right seniority, low skill overlap — review manually)"],
  ];

  for (const [key, heading] of sections) {
    lines.push(`## ${heading}`);
    lines.push("");
    const items = buckets[key];
    if (!items.length) {
      lines.push("_None found in this window._");
    } else {
      items.forEach((p, i) => {
        const salaryStr = p.salaryMax
          ? `$${Math.round(p.salaryMax).toLocaleString()}${p.salaryAnnotation}`
          : "salary not disclosed";
        const skillsStr = p.matchedSkills.length
          ? `skills matched: ${p.matchedSkills.join(", ")} (${p.matchedSkills.length})`
          : "no direct skill overlap";
        lines.push(
          `${i + 1}. **[${p.title} @ ${p.company}](${p.url})** — ${salaryStr} — ${skillsStr} — source: ${p.source}`
        );
      });
    }
    lines.push("");
  }

  lines.push("## Summary Stats");
  lines.push("");
  lines.push(`- ${stats.fetched} postings fetched`);
  lines.push(`- ${stats.afterRecency} after ${SINCE_HOURS}h recency filter`);
  lines.push(`- ${stats.afterRemote} remote`);
  lines.push(`- ${stats.stretchLevel} at stretch/long-shot seniority level`);
  lines.push(
    `- ${buckets.strong.length} strong / ${buckets.likely.length} likely / ${buckets.adjacent.length} adjacent-domain`
  );
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const config = loadConfig();
  const { resume, isPlaceholder } = loadResume();

  if (isPlaceholder) {
    console.warn(
      "[job-search] resume.yaml has unfilled REPLACE_ME fields — scoring will be unreliable. Fill it in for real results."
    );
  }

  const [remotive, remoteok, arbeitnow, wwr] = await Promise.all([
    fetchRemotive(config),
    fetchRemoteOK(config),
    fetchArbeitnow(config),
    fetchWeWorkRemotely(config),
  ]);

  const all = [...remotive, ...remoteok, ...arbeitnow, ...wwr];
  const fetched = all.length;

  const afterRecency = all.filter((p) => withinRecency(p, SINCE_HOURS));
  const afterRemote = afterRecency.filter((p) => p.remote);

  const seen = new Set();
  const deduped = [];
  for (const p of afterRemote) {
    const key = dedupeKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const scored = deduped.map((p) => scorePosting(p, resume, config));
  const stretchLevel = scored.filter((p) => p.isStretch || p.isLongShot).length;

  const buckets = { strong: [], likely: [], adjacent: [] };
  for (const p of scored) {
    if (p.bucket) buckets[p.bucket].push(p);
  }
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => b.score - a.score);
  }

  const stats = {
    fetched,
    afterRecency: afterRecency.length,
    afterRemote: afterRemote.length,
    stretchLevel,
    emailStatus: "pending",
  };

  const shouldAttemptEmail = !DRY_RUN || FORCE_SEND_EMAIL;
  let emailResult = { attempted: false, sent: false };
  if (shouldAttemptEmail) {
    emailResult = await trySendEmail({ buckets, stats, resume, isPlaceholder });
  }
  stats.emailStatus = !emailResult.attempted
    ? "skipped (dry-run)"
    : emailResult.sent
    ? "sent"
    : emailResult.error
    ? `failed: ${emailResult.error}`
    : "skipped (not configured)";

  const digest = formatDigest(buckets, stats, resume, isPlaceholder);

  if (DRY_RUN) {
    console.log(digest);
  } else {
    const digestDir = join(REPO_ROOT, "digest");
    if (!existsSync(digestDir)) mkdirSync(digestDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(digestDir, `${today}.md`), digest, "utf8");
    console.log(`[job-search] wrote digest/${today}.md`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, digest, { flag: "a" });
  }
}

main().catch((err) => {
  console.error("[job-search] fatal error:", err);
  process.exit(1);
});
