const bodyStyle = { color: "var(--text-dim)", fontSize: 14 };
const subheadStyle = { fontSize: 14, color: "var(--text)", margin: "20px 0 8px" };
const firstSubheadStyle = { ...subheadStyle, marginTop: 0 };

function NavEntry({ title, children }) {
  return (
    <>
      <h3 style={subheadStyle}>{title}</h3>
      <p style={bodyStyle}>{children}</p>
    </>
  );
}

export default function AboutPage() {
  return (
    <>
      <h1 style={{ fontSize: 20, margin: "0 0 20px" }}>About</h1>

      <div className="panel">
        <h2>About Fantasy Football Grand Prix</h2>
        <p style={bodyStyle}>
          Fantasy Football Grand Prix is a fun, fantasy football based side competition that draws
          inspiration from the Mario Kart video games. Every cup in a Grand Prix has four races,
          where first place earns the most points, followed by second place, third place, and so
          on. Over the course of the Grand Prix, the racer with the most points wins the cup!
        </p>
        <p style={bodyStyle}>
          If you&apos;ve played Mario Kart, you know that no lead is safe -- items, RNG, and
          shenanigans can propel anyone across the finish line before you. Don&apos;t give up
          until the cup is over!
        </p>

        <h3 style={firstSubheadStyle}>Modes and Scoring Format</h3>
        <p style={bodyStyle}>
          In fantasy football terms, the team with the highest scoring starting lineup earns the
          most points, followed by second place, third place, and so on. The default scoring
          format is for 12 teams to play as solo participants, where first place to last place
          earns points in this order: 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0.
        </p>
        <p style={bodyStyle}>
          Double Dash is a fun, cooperative mode where everyone participates in pairs -- each
          matchup has their matchup scores combined, and each player earns the same number of
          points based on their matchup placement relative to the rest of the league matchups.
          First place to last place earns points in this order: 12, 10, 9, 8, 7, 5.
        </p>
        <p style={bodyStyle}>
          Scoring formats can be changed under &quot;Change Point System&quot; on any cup for both
          Solo and Double Dash modes.
        </p>

        <h3 style={subheadStyle}>Disclaimer on Number of Weeks</h3>
        <p style={bodyStyle}>
          Out of respect and nature of competition, by default there are only 15 weeks of scoring
          rather than a perfect 16 weeks (4 weeks x 4 cups). Weeks 1-14 are regular season and
          week 15 is the first week of playoffs -- every team should participate for at least 15
          weeks.
        </p>
        <p style={bodyStyle}>
          Due to teams being eliminated from actual fantasy contention in winners and/or losers
          brackets, rosters should lock and teams should not be able to make any more add/drop
          transactions for the rest of the season once their teams have been eliminated from
          league rewards (or punishments).
        </p>
        <p style={bodyStyle}>Thus, the Grand Prix is organized as follows by default:</p>
        <ul style={{ ...bodyStyle, margin: "0 0 4px", paddingLeft: 20 }}>
          <li>Mushroom Cup: Weeks 1-3</li>
          <li>Flower Cup: Weeks 4-7</li>
          <li>Star Cup: Weeks 8-11</li>
          <li>Special Cup: Weeks 12-15</li>
        </ul>
      </div>

      <div className="panel">
        <h2>Navigation</h2>

        <div style={{ marginTop: -12 }}>
          <NavEntry title="Contests">
            Grand Prix leaderboard for each cup -- Mushroom, Flower, Star, and Special Cups. Sort
            by Total Grand Prix points or Fantasy Points For, swap between Solo and Double Dash
            modes, and view data as a Table or Chart.
          </NavEntry>

          <NavEntry title="Season Leaderboard">
            Season standings pulled directly from ESPN or Sleeper for the regular season. Weekly
            trend charts are provided for reference and performance for all teams, which can be
            filtered and reduced by clicking on a single team name within the leaderboard and
            charts. Change the weeks in the week filter to view team performance during a specific
            stretch of the season.
          </NavEntry>

          <NavEntry title="Players & Positions">
            Points by Position, by Team aggregates scores from each team by position in a stacked
            column chart. Player Totals are provided to gain further insight into starting player
            performance. Change the weeks in the week filter to view team performance during a
            specific stretch of the season, and filter by team, position, or player.
          </NavEntry>

          <NavEntry title="Matchups & Schedule">
            Season matchups and scoreboard with team record and winners highlighted in green.
          </NavEntry>

          <h3 style={subheadStyle}>Leagues</h3>
          <p style={bodyStyle}>
            Enter league information from ESPN or Sleeper. For private leagues, ESPN requires
            specific credentials and information about your league: SWID, ESPN S2, and League ID.
            Choose which seasons to extract data from. A passphrase is required to add or remove
            leagues.
          </p>
          <p style={bodyStyle}>Anyone can add a Sleeper league with the Sleeper League ID.</p>
        </div>
      </div>

      <div className="panel">
        <h2>Credits</h2>
        <p style={bodyStyle}>
          Shout out to my brother for the idea. He has hosted this for his league for a couple
          seasons before my friend league adopted the idea. He has more customizations and fun,
          creative manual additions that have not yet been built in to this platform.
        </p>
        <p style={bodyStyle}>
          This project has been limited to the current scope of my own league&apos;s rules and
          interests.
        </p>
        <p style={bodyStyle}>Claude is the MVP for doing most of the heavy lifting and development.</p>
      </div>
    </>
  );
}
