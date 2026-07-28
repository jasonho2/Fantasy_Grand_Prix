import "./globals.css";
import Nav from "./components/Nav";

export const metadata = {
  title: "ESPN Fantasy Football Dashboard",
  description: "League standings, player breakdowns, and matchup history",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
