import { splitProps, type JSX } from 'solid-js'
import Add from 'virtual:material-symbol/add'
import ArrowDownward from 'virtual:material-symbol/arrow-downward'
import ArrowUpward from 'virtual:material-symbol/arrow-upward'
import MaterialCheck from 'virtual:material-symbol/check'
import Close from 'virtual:material-symbol/close'
import MaterialCode from 'virtual:material-symbol/code'
import ContentCopy from 'virtual:material-symbol/content-copy'
import MaterialDatabase from 'virtual:material-symbol/database'
import Delete from 'virtual:material-symbol/delete'
import Description from 'virtual:material-symbol/description'
import MaterialEdit from 'virtual:material-symbol/edit'
import FilterAlt from 'virtual:material-symbol/filter-alt'
import KeyboardCommandKey from 'virtual:material-symbol/keyboard-command-key'
import MaterialKeep from 'virtual:material-symbol/keep'
import MaterialKey from 'virtual:material-symbol/key'
import KeyboardArrowDown from 'virtual:material-symbol/keyboard-arrow-down'
import KeyboardArrowLeft from 'virtual:material-symbol/keyboard-arrow-left'
import KeyboardArrowRight from 'virtual:material-symbol/keyboard-arrow-right'
import LeftPanelOpen from 'virtual:material-symbol/left-panel-open'
import MoreHoriz from 'virtual:material-symbol/more-horiz'
import PendingActions from 'virtual:material-symbol/pending-actions'
import PlayArrow from 'virtual:material-symbol/play-arrow'
import MaterialRedo from 'virtual:material-symbol/redo'
import MaterialRefresh from 'virtual:material-symbol/refresh'
import MaterialSave from 'virtual:material-symbol/save'
import Schedule from 'virtual:material-symbol/schedule'
import MaterialSearch from 'virtual:material-symbol/search'
import MaterialSettings from 'virtual:material-symbol/settings'
import TableView from 'virtual:material-symbol/table-view'
import MaterialUndo from 'virtual:material-symbol/undo'
import ViewColumn from 'virtual:material-symbol/view-column'
import Visibility from 'virtual:material-symbol/visibility'
import Warning from 'virtual:material-symbol/warning'

export type IconProps = Omit<JSX.SvgSVGAttributes<SVGSVGElement>, 'viewBox' | 'children'> & { size?: number; title?: string }

function icon(name: string, path: string) {
  return (props: IconProps) => {
    const [local, rest] = splitProps(props, ['size', 'class', 'title'])
    const size = () => local.size ?? 18
    return <svg
      width={size()}
      height={size()}
      viewBox="0 -960 960 960"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class={['material-symbols', `material-symbols_${name}`, local.class].filter(Boolean).join(' ')}
      aria-hidden={local.title ? undefined : 'true'}
      attr:focusable="false"
      {...rest}
    >
      {local.title ? <title>{local.title}</title> : null}
      <path d={path} fill="currentColor"/>
    </svg>
  }
}

export const Database = icon('database', MaterialDatabase)
export const Table = icon('table-view', TableView)
export const Eye = icon('visibility', Visibility)
export const Search = icon('search', MaterialSearch)
export const Plus = icon('add', Add)
export const ChevronDown = icon('keyboard-arrow-down', KeyboardArrowDown)
export const ChevronLeft = icon('keyboard-arrow-left', KeyboardArrowLeft)
export const ChevronRight = icon('keyboard-arrow-right', KeyboardArrowRight)
export const More = icon('more-horiz', MoreHoriz)
export const Pending = icon('pending-actions', PendingActions)
export const Play = icon('play-arrow', PlayArrow)
export const Refresh = icon('refresh', MaterialRefresh)
export const Columns = icon('view-column', ViewColumn)
export const Filter = icon('filter-alt', FilterAlt)
export const Code = icon('code', MaterialCode)
export const X = icon('close', Close)
export const Key = icon('key', MaterialKey)
export const ArrowUp = icon('arrow-upward', ArrowUpward)
export const ArrowDown = icon('arrow-downward', ArrowDownward)
export const PanelLeft = icon('left-panel-open', LeftPanelOpen)
export const File = icon('description', Description)
export const Clock = icon('schedule', Schedule)
export const Check = icon('check', MaterialCheck)
export const Alert = icon('warning', Warning)
export const Trash = icon('delete', Delete)
export const Save = icon('save', MaterialSave)
export const Undo = icon('undo', MaterialUndo)
export const Redo = icon('redo', MaterialRedo)
export const Settings = icon('settings', MaterialSettings)
export const Command = icon('keyboard-command-key', KeyboardCommandKey)
export const Edit = icon('edit', MaterialEdit)
export const Pin = icon('keep', MaterialKeep)
export const Copy = icon('content-copy', ContentCopy)
