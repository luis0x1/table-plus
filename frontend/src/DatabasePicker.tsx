import { useEffect, useRef, useState } from 'react'
import { api } from './bridge'
import type { ConnectionStatus } from './types'
import { Alert, Check, ChevronDown, Database, Refresh, Search } from './icons'

export default function DatabasePicker({ status, onSelect }: { status: ConnectionStatus; onSelect: (database: string) => void }) {
  const [open, setOpen] = useState(false)
  const [databases, setDatabases] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setError(''); setFilter(''); setDatabases([])
    api().ListDatabases(status.id).then(next => { if (!cancelled) setDatabases(next ?? []) })
      .catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, status.id, retry])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!containerRef.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  const filtered = databases.filter(name => name.toLowerCase().includes(filter.toLowerCase()))
  return <div className="database-picker" ref={containerRef}>
    <button className="database-picker-trigger" ref={triggerRef} aria-label={`Choose database: ${status.database}`} aria-haspopup="dialog" aria-expanded={open} title={status.database} onClick={() => setOpen(value => !value)}><Database size={16}/><span>{status.database}</span><ChevronDown size={13} className={open ? '' : 'flip-vertical'}/></button>
    {open && <section className="database-menu" role="dialog" aria-label="Databases">
      <header><b>Databases</b><span>{status.driver === 'PostgreSQL' ? status.name : 'SQLite'}</span></header>
      <label className="database-menu-search"><Search size={14}/><input aria-label="Search databases" placeholder="Search databases…" value={filter} onChange={event => setFilter(event.target.value)} autoFocus/></label>
      {loading ? <div className="database-menu-message" role="status"><Refresh size={14} className="spin"/> Loading databases…</div> : error ? <div className="database-menu-message error" role="alert"><Alert size={15}/><span>{error}</span><button className="secondary" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : <div className="database-menu-list">{filtered.map(name => <button key={name} className={name === status.database ? 'active' : ''} title={name} aria-pressed={name === status.database} onClick={() => { setOpen(false); triggerRef.current?.focus(); onSelect(name) }}><Database size={15}/><span>{name}</span>{name === status.database && <Check size={14}/>}</button>)}{!filtered.length && <p className="database-menu-message">No databases found.</p>}</div>}
    </section>}
  </div>
}
