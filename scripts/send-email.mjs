// Pluggable email delivery for the job-search digest.
//
// Currently supports Resend (https://resend.com) via a single API key. If
// RESEND_API_KEY is not set, sending is skipped gracefully — the digest file
// and $GITHUB_STEP_SUMMARY are always produced regardless of email config,
// so an unconfigured mail step never fails the workflow.

const TO_ADDRESS = process.env.JOB_SEARCH_EMAIL_TO || "leonardo.cedeno@gmail.com";
const FROM_ADDRESS = process.env.JOB_SEARCH_EMAIL_FROM || "job-search-agent@resend.dev";

function renderHtml({ buckets, stats }) {
  const section = (title, items) => `
    <h2>${title}</h2>
    ${
      items.length
        ? `<ol>${items
            .map(
              (p) =>
                `<li><a href="${p.url}">${p.title} @ ${p.company}</a> — ${
                  p.salaryMax ? `$${Math.round(p.salaryMax).toLocaleString()}` : "salary not disclosed"
                } — ${p.source}</li>`
            )
            .join("")}</ol>`
        : "<p><em>None found in this window.</em></p>"
    }`;

  return `
    <h1>Job Search Digest</h1>
    <p>${stats.fetched} fetched, ${stats.afterRecency} recent, ${stats.afterRemote} remote, ${stats.stretchLevel} stretch-level.</p>
    ${section("Strong Matches", buckets.strong)}
    ${section("Likely Matches", buckets.likely)}
    ${section("Adjacent-Domain Stretch", buckets.adjacent)}
  `;
}

/**
 * Attempts to send the digest by email. Never throws — callers should treat
 * the return value as the source of truth for whether email went out.
 * @returns {Promise<{attempted: boolean, sent: boolean, error?: string}>}
 */
export async function trySendEmail({ buckets, stats, resume, isPlaceholder }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      "[send-email] Email not configured — skipping. Set RESEND_API_KEY in repo Settings > Secrets and variables > Actions to enable."
    );
    return { attempted: false, sent: false };
  }

  const totalMatches = buckets.strong.length + buckets.likely.length + buckets.adjacent.length;
  const subject = isPlaceholder
    ? "Job Search Digest — resume.yaml not filled in yet"
    : `Job Search Digest — ${totalMatches} matches (${buckets.strong.length} strong)`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [TO_ADDRESS],
        subject,
        html: renderHtml({ buckets, stats }),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log("[send-email] digest emailed successfully");
    return { attempted: true, sent: true };
  } catch (err) {
    console.warn(`[send-email] send failed (digest already written, continuing): ${err.message}`);
    return { attempted: true, sent: false, error: err.message };
  }
}
