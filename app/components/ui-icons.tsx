export function Waveform({ active }: { active: boolean }) {
  return (
    <span className={`waveform ${active ? "is-active" : ""}`} aria-hidden="true">
      {[7, 12, 18, 10, 22, 15, 8, 19, 12, 7].map((height, index) => (
        <span key={index} style={{ height }} />
      ))}
    </span>
  );
}

export function Icon({
  name,
}: {
  name: "mic" | "stop" | "download" | "volume" | "chevron";
}) {
  const paths = {
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19v2h14v-2" /></>,
    volume: <><path d="M5 10v4h4l5 4V6L9 10H5Z" /><path d="M17 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function GitHubIcon() {
  return (
    <svg className="github-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.28-.36 6.72-1.61 6.72-7.05A5.44 5.44 0 0 0 19.28 3.7 5.07 5.07 0 0 0 19.14.2S18 0 15 1.5a13.38 13.38 0 0 0-6 0C6 .2 4.86.2 4.86.2a5.07 5.07 0 0 0-.14 3.5 5.44 5.44 0 0 0-1.44 3.75c0 5.43 3.44 6.68 6.72 7.05A4.8 4.8 0 0 0 9 18v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
