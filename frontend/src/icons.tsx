import type { SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement> & { size?: number }
const Icon = ({ size = 18, children, ...props }: Props) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
)

export const Database = (p: Props) => <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></Icon>
export const Table = (p: Props) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></Icon>
export const Eye = (p: Props) => <Icon {...p}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></Icon>
export const Search = (p: Props) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Icon>
export const Plus = (p: Props) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>
export const ChevronDown = (p: Props) => <Icon {...p}><path d="m7 10 5 5 5-5"/></Icon>
export const ChevronRight = (p: Props) => <Icon {...p}><path d="m9 18 6-6-6-6"/></Icon>
export const More = (p: Props) => <Icon {...p}><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></Icon>
export const Play = (p: Props) => <Icon {...p}><path d="m8 5 11 7-11 7Z"/></Icon>
export const Refresh = (p: Props) => <Icon {...p}><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 1-2-5"/></Icon>
export const Columns = (p: Props) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></Icon>
export const Filter = (p: Props) => <Icon {...p}><path d="M4 5h16l-6 7v5l-4 2v-7Z"/></Icon>
export const Code = (p: Props) => <Icon {...p}><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14"/></Icon>
export const X = (p: Props) => <Icon {...p}><path d="m6 6 12 12M18 6 6 18"/></Icon>
export const Key = (p: Props) => <Icon {...p}><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 8l2 2M17 6l2 2"/></Icon>
export const ArrowUp = (p: Props) => <Icon {...p}><path d="m7 11 5-5 5 5M12 6v12"/></Icon>
export const ArrowDown = (p: Props) => <Icon {...p}><path d="m7 13 5 5 5-5M12 18V6"/></Icon>
export const PanelLeft = (p: Props) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></Icon>
export const File = (p: Props) => <Icon {...p}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></Icon>
export const Clock = (p: Props) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>
export const Check = (p: Props) => <Icon {...p}><path d="m5 12 4 4L19 6"/></Icon>
export const Alert = (p: Props) => <Icon {...p}><path d="M12 3 2.5 20h19Z"/><path d="M12 9v4M12 17h.01"/></Icon>
export const Trash = (p: Props) => <Icon {...p}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></Icon>
export const Save = (p: Props) => <Icon {...p}><path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></Icon>
export const Undo = (p: Props) => <Icon {...p}><path d="m9 7-5 5 5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></Icon>
export const Redo = (p: Props) => <Icon {...p}><path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></Icon>
