"use client";

import { useState } from "react";

type Agent = "Codex" | "Claude Code";
type OS = "macOS" | "Windows";

const integrations = [
  {
    name: "Notion",
    creates: "A context-aware workspace—such as Life OS—with pages, databases, views, and relevant emojis.",
    detail: "Aurous finds the right place and shapes the workspace around the context you give it.",
  },
  {
    name: "Linear",
    creates: "A context-aware operating project with issues, labels, and milestones.",
    detail: "Aurous selects a writable team, then turns your context into an operating workflow.",
  },
  {
    name: "Airtable",
    creates: "A context-aware base with tables, fields, views, and starter structure.",
    detail: "Aurous creates the useful starting shape, so you can begin working instead of configuring.",
  },
  {
    name: "Trello",
    creates: "A context-aware board with lists, cards, and checklists.",
    detail: "Aurous creates a board that reflects the work, priorities, and next actions in your context.",
  },
];

const contextTemplates = [
  ["Software project", "Create an Aurous Context Pack for this software project. Summarize the goal, current work, milestones, risks, people, and the next useful tasks. Keep it concise and structured."],
  ["Job search", "Create an Aurous Context Pack for my job search. Summarize target roles, companies, application stages, contacts, follow-ups, deadlines, and next actions."],
  ["Content calendar", "Create an Aurous Context Pack for this content calendar. Summarize audiences, channels, themes, publishing dates, assets, approvals, and next actions."],
  ["Product launch", "Create an Aurous Context Pack for this product launch. Summarize the launch goal, owners, workstreams, dates, dependencies, risks, and next actions."],
  ["Personal planning", "Create an Aurous Context Pack for my personal planning. Summarize priorities, commitments, routines, deadlines, and the next small actions."],
] as const;

const presets = [
  ["Product HQ", "Notion", "A product home, roadmap, decisions, and linked work.", "Build a Product HQ for this project with a roadmap, decisions, specs, and next actions."],
  ["Engineering Sprint", "Linear", "A sprint project with milestones, issues, labels, and priorities.", "Build an Engineering Sprint for this project with a milestone, prioritized issues, and clear owners."],
  ["Launch Tracker", "Linear", "A launch project with a timeline, cross-functional work, and risks.", "Build a Launch Tracker for this launch with milestones, owners, dependencies, and risk tracking."],
  ["Content Pipeline", "Notion", "A content database, production stages, and publishing views.", "Build a Content Pipeline with ideas, drafts, approvals, publishing dates, and channel views."],
  ["Job Search", "Airtable", "A role pipeline, companies, contacts, and follow-ups.", "Build a Job Search workspace with roles, companies, contacts, follow-ups, and application stages."],
  ["Personal Command Center", "Notion", "A calm home for priorities, routines, and personal projects.", "Build a Personal Command Center with weekly priorities, routines, projects, and a simple next-actions view."],
] as const;

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      // Feedback still confirms the action when a browser blocks clipboard access.
    } finally {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
    }
  }
  return <button className="copy-button" onClick={copy} aria-label={`Copy ${label}`}>{copied ? "Copied" : label}</button>;
}

function CommandBlock({ children, label = "Copy command" }: { children: string; label?: string }) {
  return <div className="command-block"><code>{children}</code><CopyButton value={children} label={label} /></div>;
}

export default function Home() {
  const [os, setOs] = useState<OS>("macOS");
  const [agent, setAgent] = useState<Agent>("Codex");
  const [selectedTool, setSelectedTool] = useState("Notion");
  const [selectedPreset, setSelectedPreset] = useState("Product HQ");
  const activePreset = presets.find(([name]) => name === selectedPreset) ?? presets[0];

  return (
    <main>
      <nav className="nav shell" aria-label="Primary navigation">
        <a className="brand" href="#top"><img src="/aurous-logo.png" alt="Aurous logo" /><span>Aurous</span></a>
        <div className="nav-links">
          <a href="#overview">How it works</a><a href="#setup">Onboarding</a><a href="#connect">Apps</a><a href="#context">Context</a><a href="#run">Preview</a>
        </div>
        <a className="github-link" href="https://github.com/SuperfiedStudd/aurous" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
      </nav>

      <section className="hero shell" id="top">
        <div className="hero-copy reveal">
          <p className="eyebrow">CLI-first workspace setup</p>
          <h1>Aurous</h1>
          <p className="tagline">Productivity Resolved.</p>
          <p className="hero-intro">Aurous turns your context into a ready-to-use workspace. No structure to design, destination to select, or technical setup to learn first.</p>
          <div className="hero-actions"><a className="button primary" href="#run">See the flow <span>→</span></a><a className="button secondary" href="#connect">Explore apps</a><a className="button demo-button" href="https://youtu.be/PQ555x5A6LM" target="_blank" rel="noreferrer">Watch Demo <span aria-hidden="true">↗</span></a></div>
        </div>
        <div className="hero-mark reveal"><img src="/aurous-logo.png" alt="Two dark crystalline shards, outlined in fire" /></div>
        <div className="terminal hero-terminal reveal" aria-label="Aurous workflow preview">
          <div className="terminal-head"><span><i></i><i></i><i></i></span><b>aurous</b><em>resolved workflow</em></div>
          <div className="terminal-lines"><p><span>01</span> Add your context <b>plain language</b></p><p><span>02</span> Ask Aurous to set up an app <b>zero-config</b></p><p><span>03</span> Review the complete preview <b>every action</b></p><p><span>04</span> Type apply <b>you approve</b></p><p><span>05</span> Start working <b>finished</b></p></div>
        </div>
      </section>

      <section className="section shell" id="overview">
        <div className="section-heading reveal"><p className="eyebrow">How it works</p><h2>From your context to a working app in four clear steps.</h2><p>Aurous handles the setup details, then shows you everything before it writes.</p></div>
        <div className="steps-grid">
          {["Add your context", "Ask Aurous to set up an app", "Review the complete preview", "Type apply"].map((title, i) => <article className="step reveal" key={title}><span>0{i + 1}</span><h3>{title}</h3><p>{["Share a folder, notes, or a short plain-language brief.", "Name Notion, Linear, Airtable, or Trello and describe the outcome.", "Every planned page, project, table, board, and task is shown before changes begin.", "Your typed approval turns the complete preview into the finished workspace."][i]}</p></article>)}
        </div>
      </section>

      <section className="section demo-section" id="demo">
        <div className="shell demo-layout">
          <div className="section-heading reveal"><p className="eyebrow">See it in action</p><h2>Watch Aurous resolve a workspace.</h2><p>Follow the path from context to a complete, human-approved result.</p><a className="demo-link" href="https://youtu.be/PQ555x5A6LM" target="_blank" rel="noreferrer">Open demo on YouTube <span aria-hidden="true">↗</span></a></div>
          <div className="demo-frame reveal"><iframe src="https://www.youtube-nocookie.com/embed/PQ555x5A6LM" title="Aurous demo video" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen /></div>
        </div>
      </section>

      <section className="section setup-section" id="setup">
        <div className="shell"><div className="section-heading reveal"><p className="eyebrow">Zero-config onboarding</p><h2>Tell Aurous what you want. It handles the setup.</h2><p>You do not need page IDs, team keys, base IDs, board IDs, schemas, destination selection, or technical setup knowledge.</p></div>
          <div className="toggle-row reveal"><div className="toggle-group" aria-label="Choose operating system"><span>Operating system</span>{(["macOS", "Windows"] as OS[]).map(item => <button className={os === item ? "active" : ""} onClick={() => setOs(item)} key={item}>{item}</button>)}</div><div className="toggle-group" aria-label="Choose local agent"><span>Local agent</span>{(["Codex", "Claude Code"] as Agent[]).map(item => <button className={agent === item ? "active" : ""} onClick={() => setAgent(item)} key={item}>{item}</button>)}</div></div>
          <div className="setup-list">
            <article className="setup-item reveal"><div><span>01</span><h3>Add your context</h3><p>Start with a folder, notes, or a concise brief about what matters.</p></div><CommandBlock label="Example context">Launch plan, owners, dates, dependencies, risks, and next actions.</CommandBlock></article>
            <article className="setup-item reveal"><div><span>02</span><h3>Ask for the app you need</h3><p>Say what you want to set up in plain language. Aurous resolves the destination and structure.</p></div><CommandBlock>Set up a Linear project for this launch.</CommandBlock></article>
            <article className="setup-item reveal"><div><span>03</span><h3>Review the complete preview</h3><p>See the full planned workspace before anything is created.</p></div><CommandBlock>Preview every planned action</CommandBlock></article>
            <article className="setup-item reveal"><div><span>04</span><h3>Type apply</h3><p>Aurous writes only after your explicit approval.</p></div><CommandBlock>apply</CommandBlock></article>
          </div>
        </div>
      </section>

      <section className="section shell" id="connect">
        <div className="section-heading reveal"><p className="eyebrow">Apps Aurous sets up</p><h2>Choose the outcome, not the configuration.</h2><p>Context-first onboarding for the tools where your work already lives.</p></div>
        <div className="tool-tabs reveal" role="tablist" aria-label="Supported productivity tools">{integrations.map(tool => <button key={tool.name} className={selectedTool === tool.name ? "active" : ""} onClick={() => setSelectedTool(tool.name)} role="tab" aria-selected={selectedTool === tool.name}>{tool.name}</button>)}</div>
        <div className="integrations-grid">
          {integrations.map(tool => <article className={`integration-card reveal ${selectedTool === tool.name ? "selected" : ""}`} key={tool.name} id={`tool-${tool.name.toLowerCase()}`}><div className="card-top"><h3>{tool.name}</h3><span className="connected"><i></i> Zero-config</span></div><p><b>Creates</b>{tool.creates}</p><p><b>How it works</b>{tool.detail}</p></article>)}
        </div>
        <p className="documentation-note">No IDs, schemas, or destination-picking required. Aurous keeps the decision in plain language and the preview complete.</p>
      </section>

      <section className="section context-section" id="context"><div className="shell"><div className="split-heading reveal"><div><p className="eyebrow">Generate context</p><h2>Tell Aurous what matters, in the format you already have.</h2></div><p>Use an existing folder, copy a short brief from a web app, or export and summarize the parts of a GUI tool you want to plan from.</p></div>
        <div className="context-ways"><article className="reveal"><span>01</span><h3>Existing project folder</h3><p>Point Aurous at a project directory. It builds a bounded Context Pack and skips secrets, dependencies, and build output.</p></article><article className="reveal"><span>02</span><h3>Copied web information</h3><p>Paste a project brief, roadmap, or notes from a web app into a short source document.</p></article><article className="reveal"><span>03</span><h3>Exported or summarized GUI work</h3><p>Export the useful parts of a desktop tool, or ask your local agent to create a plain-language summary.</p></article></div>
        <div className="template-heading"><h3>Context Pack prompts</h3><p>Paste one into {agent} and edit the bracketed details.</p></div>
        <div className="template-grid">{contextTemplates.map(([name, prompt]) => <article className="template reveal" key={name}><div><span>{name}</span><CopyButton value={prompt} label="Copy prompt" /></div><code>{prompt}</code></article>)}</div>
      </div></section>

      <section className="section shell" id="presets"><div className="section-heading reveal"><p className="eyebrow">Starting points</p><h2>Bring the outcome. Aurous builds the shape.</h2><p>Use a plain-language prompt as a starting point, then review the complete workspace before it is created.</p></div>
        <div className="preset-layout"><div className="preset-list">{presets.map(([name, destination, description]) => <button className={`preset-row reveal ${selectedPreset === name ? "active" : ""}`} onClick={() => setSelectedPreset(name)} key={name}><span>{name}</span><small>{destination}</small><p>{description}</p></button>)}</div><aside className="preset-detail reveal"><p className="eyebrow">Example outcome</p><h3>{activePreset[0]}</h3><dl><div><dt>App</dt><dd>{activePreset[1]}</dd></div><div><dt>Aurous creates</dt><dd>{activePreset[2]}</dd></div></dl><p className="sample-label">Ask Aurous</p><code>{activePreset[3]}</code><CopyButton value={activePreset[3]} label="Copy prompt" /></aside></div>
      </section>

      <section className="section run-section" id="run"><div className="shell"><div className="section-heading reveal"><p className="eyebrow">The Aurous flow</p><h2>Add context. See everything. Type <code>apply</code>.</h2><p>There is no hidden setup phase. The complete preview is the moment to confirm the structure, wording, and next actions Aurous will create.</p></div>
        <div className="flow"><article className="reveal"><span>01</span><h3>Describe the work</h3><p>Give Aurous your context and ask it to set up the app that fits.</p><CommandBlock>Set up a Life OS in Notion from this context.</CommandBlock></article><article className="reveal"><span>02</span><h3>Review every detail</h3><p>Aurous presents the complete preview before any write happens.</p><CommandBlock>Preview the complete workspace</CommandBlock></article><article className="reveal"><span>03</span><h3>Apply when ready</h3><p>Type <code>apply</code> only when the preview is exactly what you want.</p><CommandBlock>apply</CommandBlock></article></div>
        <p className="reassurance reveal">No page IDs, team keys, base IDs, board IDs, schemas, destination selection, or technical setup knowledge. Just context, a clear request, a complete preview, and <code>apply</code>.</p>
      </div></section>

      <section className="safety"><div className="shell safety-inner"><div className="reveal"><p className="eyebrow">Built for deliberate work</p><h2>Safe by design.</h2></div><div><ul className="safety-list reveal"><li><b>Inspect before writing.</b> Destination discovery is read-only.</li><li><b>Preview every action.</b> The saved plan is the write allowlist.</li><li><b>Require typed approval.</b> Nothing executes without it.</li><li><b>Use exact external IDs.</b> Existing objects are verified before reuse.</li><li><b>Stop on ambiguity.</b> Aurous never guesses which match you meant.</li><li><b>Rerun safely.</b> Compatible exact matches can be reused or skipped.</li><li><b>Keep evidence.</b> Run artifacts and redacted diagnostics remain local.</li></ul><p className="reassurance reveal">Built with Codex and GPT-5.6 for product planning, implementation, debugging, safety analysis, and integration validation.</p></div></div></section>

      <footer className="footer shell"><a className="brand" href="#top"><img src="/aurous-logo.png" alt="" /><span>Aurous</span></a><p>Productivity Resolved</p><div><a href="https://github.com/SuperfiedStudd/aurous" target="_blank" rel="noreferrer">GitHub</a><a href="#setup">Setup</a><a href="https://github.com/SuperfiedStudd/aurous#readme" target="_blank" rel="noreferrer">Documentation</a><a href="#connect">Supported tools</a></div></footer>
    </main>
  );
}
