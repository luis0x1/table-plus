import type { IconProps, MaterialSymbolsComponent } from '@material-symbols-svg/react/rounded/w500'
import { KeyboardCommandKeyW500 } from '@material-symbols-svg/react/rounded/keyboard-command-key'
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
import MaterialKeep from 'virtual:material-symbol/keep'
import MaterialKey from 'virtual:material-symbol/key'
import KeyboardArrowDown from 'virtual:material-symbol/keyboard-arrow-down'
import KeyboardArrowLeft from 'virtual:material-symbol/keyboard-arrow-left'
import KeyboardArrowRight from 'virtual:material-symbol/keyboard-arrow-right'
import LeftPanelOpen from 'virtual:material-symbol/left-panel-open'
import MoreHoriz from 'virtual:material-symbol/more-horiz'
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

const icon = (Component: MaterialSymbolsComponent) => ({ size = 18, ...props }: IconProps) => (
  <Component size={size} aria-hidden="true" focusable="false" {...props}/>
)

export const Database = icon(MaterialDatabase)
export const Table = icon(TableView)
export const Eye = icon(Visibility)
export const Search = icon(MaterialSearch)
export const Plus = icon(Add)
export const ChevronDown = icon(KeyboardArrowDown)
export const ChevronLeft = icon(KeyboardArrowLeft)
export const ChevronRight = icon(KeyboardArrowRight)
export const More = icon(MoreHoriz)
export const Play = icon(PlayArrow)
export const Refresh = icon(MaterialRefresh)
export const Columns = icon(ViewColumn)
export const Filter = icon(FilterAlt)
export const Code = icon(MaterialCode)
export const X = icon(Close)
export const Key = icon(MaterialKey)
export const ArrowUp = icon(ArrowUpward)
export const ArrowDown = icon(ArrowDownward)
export const PanelLeft = icon(LeftPanelOpen)
export const File = icon(Description)
export const Clock = icon(Schedule)
export const Check = icon(MaterialCheck)
export const Alert = icon(Warning)
export const Trash = icon(Delete)
export const Save = icon(MaterialSave)
export const Undo = icon(MaterialUndo)
export const Redo = icon(MaterialRedo)
export const Settings = icon(MaterialSettings)
export const Command = icon(KeyboardCommandKeyW500)
export const Edit = icon(MaterialEdit)
export const Pin = icon(MaterialKeep)
export const Copy = icon(ContentCopy)
