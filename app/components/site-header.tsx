import { GitHubIcon } from "@/app/components/ui-icons";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="#top" aria-label="xlator ホーム">
        <span className="brand-mark"><span>あ</span><span>A</span></span>
        <span>xlator</span>
      </a>
      <div className="header-meta">
        <span className="realtime-badge">REALTIME</span>
        <span className="local-label"><span className="local-dot" /> localhost</span>
        <a
          className="github-link"
          href="https://github.com/shinichi-takayanagi/xlator"
          target="_blank"
          rel="noreferrer"
          aria-label="GitHubでリポジトリを開く"
        >
          <GitHubIcon />
        </a>
      </div>
    </header>
  );
}
