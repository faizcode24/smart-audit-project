import React from 'react';

const API = '/api/audit-entries';
const POLL_MS = 2000;

async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n ?? 0);
const EMPTY_FORM = { entityName: '', description: '', monetaryImpact: '', controlId: '' };

/**
 * Primary UI: a React class component. All UI state (entries, edit drafts, AI loading
 * indicators, similarity-search state) lives in this.state.
 */
export default class AuditDashboard extends React.Component {
  state = {
    entries: [],
    loading: true,
    error: null,
    notice: null, // { kind: 'fast' | 'ai' | 'info', text }
    form: { ...EMPTY_FORM },
    creating: false,
    edits: {}, // { [id]: { description, monetaryImpact, controlId, auditorNotes, saving } }
    similar: {}, // { [id]: { open, loading, error, results, comparedAgainst } }
  };

  pollTimer = null;
  noticeTimer = null;

  componentDidMount() {
    this.fetchEntries();
    this.pollTimer = setInterval(this.fetchEntries, POLL_MS); // live stream: status badges update as the worker finishes
  }

  componentWillUnmount() {
    clearInterval(this.pollTimer);
    clearTimeout(this.noticeTimer);
  }

  // ------------------------------- data -------------------------------

  fetchEntries = async () => {
    try {
      const { data } = await request(API);
      this.setState({ entries: data, loading: false, error: null });
    } catch (err) {
      this.setState({ loading: false, error: err.message });
    }
  };

  showNotice = (kind, text) => {
    clearTimeout(this.noticeTimer);
    this.setState({ notice: { kind, text } });
    this.noticeTimer = setTimeout(() => this.setState({ notice: null }), 6000);
  };

  // ------------------------------- create -------------------------------

  onFormChange = (field) => (e) => this.setState((s) => ({ form: { ...s.form, [field]: e.target.value } }));

  createEntry = async (e) => {
    e.preventDefault();
    const { form } = this.state;
    this.setState({ creating: true });
    try {
      await request(API, { method: 'POST', body: JSON.stringify({ ...form, monetaryImpact: Number(form.monetaryImpact) }) });
      this.setState({ form: { ...EMPTY_FORM } });
      this.showNotice('info', 'Entry saved as PENDING. The AI worker will enrich it in a moment.');
      await this.fetchEntries();
    } catch (err) {
      this.showNotice('error', err.message);
    } finally {
      this.setState({ creating: false });
    }
  };

  // ------------------------------- edit (smart delta on the server) -------------------------------

  startEdit = (entry) =>
    this.setState((s) => ({
      edits: {
        ...s.edits,
        [entry._id]: {
          description: entry.description,
          monetaryImpact: String(entry.monetaryImpact),
          controlId: entry.controlId,
          auditorNotes: entry.aiMetadata?.auditorNotes ?? '',
          saving: false,
        },
      },
    }));

  cancelEdit = (id) =>
    this.setState((s) => {
      const edits = { ...s.edits };
      delete edits[id];
      return { edits };
    });

  onEditChange = (id, field) => (e) => {
    const value = e.target.value;
    this.setState((s) => ({ edits: { ...s.edits, [id]: { ...s.edits[id], [field]: value } } }));
  };

  saveEdit = async (id) => {
    const draft = this.state.edits[id];
    this.setState((s) => ({ edits: { ...s.edits, [id]: { ...draft, saving: true } } }));
    try {
      // Always send the full form: the server decides whether AI must re-run.
      const body = {
        description: draft.description,
        monetaryImpact: Number(draft.monetaryImpact),
        controlId: draft.controlId,
        auditorNotes: draft.auditorNotes,
      };
      const { path } = await request(`${API}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (path === 'FAST_TRACK') this.showNotice('fast', 'Fast track: saved instantly, AI pipeline bypassed.');
      else if (path === 'AI_REQUEUE') this.showNotice('ai', 'Core fields changed: re-queued for AI risk recomputation.');
      else this.showNotice('info', 'No changes detected, nothing was written.');
      this.cancelEdit(id);
      await this.fetchEntries();
    } catch (err) {
      this.showNotice('error', err.message);
      this.setState((s) => ({ edits: { ...s.edits, [id]: { ...draft, saving: false } } }));
    }
  };

  // ------------------------------- vector similarity -------------------------------

  toggleSimilar = async (id) => {
    const current = this.state.similar[id];
    if (current?.open) {
      this.setState((s) => ({ similar: { ...s.similar, [id]: { ...current, open: false } } }));
      return;
    }
    this.setState((s) => ({ similar: { ...s.similar, [id]: { open: true, loading: true, error: null, results: [] } } }));
    try {
      const data = await request(`${API}/${id}/similar`, { method: 'POST', body: JSON.stringify({ limit: 3 }) });
      this.setState((s) => ({
        similar: { ...s.similar, [id]: { open: true, loading: false, error: null, results: data.results, comparedAgainst: data.comparedAgainst } },
      }));
    } catch (err) {
      this.setState((s) => ({ similar: { ...s.similar, [id]: { open: true, loading: false, error: err.message, results: [] } } }));
    }
  };

  // ------------------------------- render helpers -------------------------------

  renderStatus(entry) {
    const { status, riskLevel } = entry.aiMetadata;
    if (status === 'PENDING') return <span className="badge badge-pending"><i className="spinner" />PENDING</span>;
    if (status === 'PROCESSING') return <span className="badge badge-processing"><i className="spinner" />ANALYZING</span>;
    if (status === 'FAILED') return <span className="badge badge-failed" title={entry.aiMetadata.lastError || ''}>FAILED</span>;
    return <span className={`badge badge-${(riskLevel || 'low').toLowerCase()}`}>{riskLevel || 'DONE'}</span>;
  }

  renderScore(entry) {
    const { riskScore, riskLevel, status } = entry.aiMetadata;
    if (riskScore == null) return <span className="muted">calculating…</span>;
    return (
      <div className={`score ${status !== 'COMPLETED' ? 'stale' : ''}`} title={status !== 'COMPLETED' ? 'Previous score; recomputing' : ''}>
        <strong>{riskScore}</strong>
        <div className="gauge"><div className={`gauge-fill fill-${(riskLevel || 'low').toLowerCase()}`} style={{ width: `${riskScore}%` }} /></div>
      </div>
    );
  }

  renderEditor(entry) {
    const id = entry._id;
    const d = this.state.edits[id];
    return (
      <tr className="detail-row" key={`${id}-edit`}>
        <td colSpan={6}>
          <div className="editor">
            <label>Description
              <textarea rows={2} value={d.description} onChange={this.onEditChange(id, 'description')} />
            </label>
            <label>Monetary impact (USD)
              <input type="number" min="0" value={d.monetaryImpact} onChange={this.onEditChange(id, 'monetaryImpact')} />
            </label>
            <label>Control ID
              <input value={d.controlId} onChange={this.onEditChange(id, 'controlId')} />
            </label>
            <label className="wide">Auditor notes
              <textarea rows={2} value={d.auditorNotes} placeholder="Notes save instantly and never re-run the AI" onChange={this.onEditChange(id, 'auditorNotes')} />
            </label>
            <div className="editor-actions">
              <button className="btn primary" disabled={d.saving} onClick={() => this.saveEdit(id)}>{d.saving ? 'Saving…' : 'Save changes'}</button>
              <button className="btn" disabled={d.saving} onClick={() => this.cancelEdit(id)}>Cancel</button>
              <span className="hint">Editing amount, description or control ID re-runs the AI. Editing notes only does not.</span>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  renderSimilar(entry) {
    const s = this.state.similar[entry._id];
    if (!s?.open) return null;
    return (
      <tr className="detail-row" key={`${entry._id}-sim`}>
        <td colSpan={6}>
          <div className="similar">
            <h4>Most similar audit exceptions</h4>
            {s.loading && <p className="muted"><i className="spinner" /> Comparing semantic vectors…</p>}
            {s.error && <p className="error-text">{s.error}</p>}
            {!s.loading && !s.error && s.results.length === 0 && <p className="muted">No other enriched entries to compare against yet.</p>}
            {!s.loading && s.results.length > 0 && (
              <>
                <ol className="similar-list">
                  {s.results.map((r) => (
                    <li key={r._id}>
                      <div className="sim-head">
                        <span className="sim-pct">{Math.round(r.similarity * 100)}% match</span>
                        <span className={`badge badge-${(r.riskLevel || 'low').toLowerCase()}`}>{r.riskLevel}</span>
                        <span className="mono">{r.evidenceId}</span>
                        <span className="muted">{r.entityName} · {money(r.monetaryImpact)}</span>
                      </div>
                      <p>{r.description}</p>
                    </li>
                  ))}
                </ol>
                <p className="muted small">Cosine similarity over 8-dimensional vectors, compared against {s.comparedAgainst} enriched entries.</p>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }

  renderRow(entry) {
    const ai = entry.aiMetadata;
    const id = entry._id;
    const editing = Boolean(this.state.edits[id]);
    const sim = this.state.similar[id];
    return (
      <React.Fragment key={id}>
        <tr className={ai.status === 'PENDING' || ai.status === 'PROCESSING' ? 'row-busy' : ''}>
          <td>
            <div className="mono">{entry.evidenceId}</div>
            <div className="entity">{entry.entityName}</div>
            <div className="muted small">{entry.controlId}</div>
          </td>
          <td className="desc">
            <div>{entry.description}</div>
            <div className="amount">{money(entry.monetaryImpact)}</div>
            {ai.auditorNotes && <div className="notes"><span>Auditor note</span> {ai.auditorNotes}</div>}
          </td>
          <td>{this.renderStatus(entry)}<div className="muted small runs" title="Successful AI enrichments for this record">AI runs: {ai.runCount}</div></td>
          <td>{this.renderScore(entry)}</td>
          <td className="summary">
            {ai.aiSummary ? <p>{ai.aiSummary}</p> : <span className="muted">Awaiting AI summary…</span>}
            {ai.anomalyFlags?.length > 0 && <div className="flags">{ai.anomalyFlags.map((f) => <span key={f} className="flag">{f}</span>)}</div>}
            {ai.semanticVector?.length > 0 && <div className="vector mono" title="Mock 8-D semantic embedding">[{ai.semanticVector.map((x) => x.toFixed(2)).join(', ')}]</div>}
          </td>
          <td className="actions">
            <button className="btn" onClick={() => (editing ? this.cancelEdit(id) : this.startEdit(entry))}>{editing ? 'Close' : 'Edit'}</button>
            <button className="btn" disabled={ai.status !== 'COMPLETED'} onClick={() => this.toggleSimilar(id)}>
              {sim?.loading ? 'Searching…' : sim?.open ? 'Hide similar' : 'Find similar'}
            </button>
          </td>
        </tr>
        {editing && this.renderEditor(entry)}
        {this.renderSimilar(entry)}
      </React.Fragment>
    );
  }

  render() {
    const { entries, loading, error, notice, form, creating } = this.state;
    const pending = entries.filter((e) => e.aiMetadata.status === 'PENDING' || e.aiMetadata.status === 'PROCESSING').length;
    const flagged = entries.filter((e) => ['HIGH', 'CRITICAL'].includes(e.aiMetadata.riskLevel)).length;

    return (
      <div className="page">
        <header className="top">
          <div>
            <h1>Continuous audit stream</h1>
            <p className="muted">Evidence is saved immediately, then scored, summarised and embedded by the AI worker.</p>
          </div>
          <dl className="stats">
            <div><dt>Entries</dt><dd>{entries.length}</dd></div>
            <div><dt>In AI queue</dt><dd>{pending}</dd></div>
            <div><dt>High or critical</dt><dd>{flagged}</dd></div>
          </dl>
        </header>

        {notice && <div className={`notice notice-${notice.kind}`} role="status">{notice.text}</div>}
        {error && <div className="notice notice-error" role="alert">Could not reach the API: {error}</div>}

        <form className="new-entry" onSubmit={this.createEntry}>
          <h2>Add audit evidence</h2>
          <div className="form-grid">
            <input required placeholder="Entity name" value={form.entityName} onChange={this.onFormChange('entityName')} />
            <input required placeholder="Control ID (e.g. CTRL-FIN-302)" value={form.controlId} onChange={this.onFormChange('controlId')} />
            <input required type="number" min="0" placeholder="Monetary impact (USD)" value={form.monetaryImpact} onChange={this.onFormChange('monetaryImpact')} />
            <input required className="grow" placeholder="Description" value={form.description} onChange={this.onFormChange('description')} />
            <button className="btn primary" type="submit" disabled={creating}>{creating ? 'Saving…' : 'Add entry'}</button>
          </div>
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Evidence</th><th>Description</th><th>AI status</th><th>Risk score</th><th>AI summary</th><th /></tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="empty">Loading entries…</td></tr>}
              {!loading && entries.length === 0 && <tr><td colSpan={6} className="empty">No audit entries yet. Run <code>npm run seed</code> or add one above.</td></tr>}
              {entries.map((entry) => this.renderRow(entry))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
}
