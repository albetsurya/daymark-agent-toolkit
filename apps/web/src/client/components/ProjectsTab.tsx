import type { ProjectDto } from '@daymark/contracts';
import { useState } from 'react';
import { daymarkApi } from '../api';

export function ProjectsTab(props: {
  projects: ProjectDto[];
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('all');
  const [busy, setBusy] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await daymarkApi.createProject({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setName('');
      setDescription('');
      await props.onRefresh();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(proj: ProjectDto) {
    setBusy(true);
    try {
      await daymarkApi.updateProject(proj.id, {
        status: proj.status === 'active' ? 'archived' : 'active',
      });
      await props.onRefresh();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  const visible = props.projects.filter((p) => filter === 'all' || p.status === filter);

  return (
    <div>
      <div className="page-header">
        <h1>Projects</h1>
        <select
          className="select"
          style={{ width: 160 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value as 'active' | 'archived' | 'all')}
        >
          <option value="all">All Projects</option>
          <option value="active">Active Only</option>
          <option value="archived">Archived Only</option>
        </select>
      </div>

      <div className="card">
        <h2>New Project</h2>
        <form onSubmit={handleCreate} className="form-grid">
          <div className="field">
            <label htmlFor="proj-name">Name</label>
            <input
              id="proj-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Core Architecture"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="proj-desc">Description (optional)</label>
            <input
              id="proj-desc"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Scope or notes"
              disabled={busy}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || name.trim().length === 0}
          >
            Create Project
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Project Directory ({visible.length})</h2>
        {visible.length === 0 ? (
          <div className="muted">No projects match this filter.</div>
        ) : (
          <div className="list">
            {visible.map((proj) => (
              <div key={proj.id} className="list-item">
                <div>
                  <div className="row">
                    <span className="item-title">{proj.name}</span>
                    <span
                      className={`badge ${proj.status === 'active' ? 'badge-success' : 'badge-warn'}`}
                    >
                      {proj.status}
                    </span>
                  </div>
                  {proj.description && <div className="item-meta">{proj.description}</div>}
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void toggleArchive(proj)}
                >
                  {proj.status === 'active' ? 'Archive' : 'Reactivate'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
