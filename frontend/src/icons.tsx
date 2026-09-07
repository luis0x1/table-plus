import type { IconBaseProps, IconType } from 'react-icons'
import {
  PiDatabaseDuotone,
  PiTableDuotone,
  PiEyeDuotone,
  PiMagnifyingGlass,
  PiPlus,
  PiCaretDownBold,
  PiCaretLeftBold,
  PiCaretRightBold,
  PiDotsThreeBold,
  PiPlayFill,
  PiArrowsClockwise,
  PiColumnsDuotone,
  PiFunnel,
  PiCode,
  PiX,
  PiKeyDuotone,
  PiArrowUp,
  PiArrowDown,
  PiSidebarDuotone,
  PiFileDuotone,
  PiClock,
  PiCheckBold,
  PiWarningDuotone,
  PiTrash,
  PiFloppyDiskDuotone,
  PiArrowUUpLeft,
  PiArrowUUpRight,
} from 'react-icons/pi'

const icon = (Component: IconType) => ({ size = 18, ...props }: IconBaseProps) => (
  <Component size={size} aria-hidden="true" {...props}/>
)

export const Database = icon(PiDatabaseDuotone)
export const Table = icon(PiTableDuotone)
export const Eye = icon(PiEyeDuotone)
export const Search = icon(PiMagnifyingGlass)
export const Plus = icon(PiPlus)
export const ChevronDown = icon(PiCaretDownBold)
export const ChevronLeft = icon(PiCaretLeftBold)
export const ChevronRight = icon(PiCaretRightBold)
export const More = icon(PiDotsThreeBold)
export const Play = icon(PiPlayFill)
export const Refresh = icon(PiArrowsClockwise)
export const Columns = icon(PiColumnsDuotone)
export const Filter = icon(PiFunnel)
export const Code = icon(PiCode)
export const X = icon(PiX)
export const Key = icon(PiKeyDuotone)
export const ArrowUp = icon(PiArrowUp)
export const ArrowDown = icon(PiArrowDown)
export const PanelLeft = icon(PiSidebarDuotone)
export const File = icon(PiFileDuotone)
export const Clock = icon(PiClock)
export const Check = icon(PiCheckBold)
export const Alert = icon(PiWarningDuotone)
export const Trash = icon(PiTrash)
export const Save = icon(PiFloppyDiskDuotone)
export const Undo = icon(PiArrowUUpLeft)
export const Redo = icon(PiArrowUUpRight)
