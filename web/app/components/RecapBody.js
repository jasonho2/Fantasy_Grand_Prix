// Renders a weekly recap's body (plain text, blank lines between
// paragraphs -- see api/recaps/route.js) as paragraphs, with the section
// labels the recap writer puts on their own line ("Race Results",
// "Podium Watch -- Contest Points", "Path to the Podium -- Projected
// Finish") styled as section headings. A paragraph counts as a heading
// when it's a single short line with no sentence-ending punctuation --
// real prose paragraphs always end in punctuation, so no markup is needed
// in the stored text. Shared by the Contests page's recap panel and the
// Weekly Report page.
const HEADING_MAX_CHARS = 60;

function isHeading(text) {
  return !text.includes("\n") && text.length <= HEADING_MAX_CHARS && !/[.!?)"']$/.test(text);
}

export default function RecapBody({ body }) {
  const paragraphs = (body || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs.map((p, i) => {
    const last = i === paragraphs.length - 1;
    if (isHeading(p)) {
      return (
        <h3 key={i} className="recap-heading">
          {p.replace(/ -- /g, " — ")}
        </h3>
      );
    }
    return (
      <p key={i} style={{ fontSize: 14, lineHeight: 1.6, margin: last ? 0 : "0 0 10px" }}>
        {p}
      </p>
    );
  });
}
