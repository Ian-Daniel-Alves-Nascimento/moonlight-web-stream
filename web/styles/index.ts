import { globalDefaultSettings, getLocalStreamSettings } from "../component/settings_menu"

// old doesn't exist anymore and is always replaced with moonlight when loading the settings
import standardUrl from "./standard.css";
import moonlightUrl from "./moonlight.css";
// Lightning fork: always applied on top of the chosen style
import lightningUrl from "./lightning.css";

export type PageStyle = "standard" | "old" | "moonlight";

let currentStyle: PageStyle | null = null
let lightningApplied = false

const styleMap: Record<PageStyle, LazyStyleModule> = {
    standard: standardUrl,
    old: standardUrl,
    moonlight: moonlightUrl
};

export function setStyle(style: PageStyle) {
    if (currentStyle && currentStyle != style) {
        styleMap[currentStyle].unuse()
    }

    styleMap[style].use()
    currentStyle = style

    // Re-insert the Lightning layer so it stays after the base style and wins
    if (lightningApplied) {
        lightningUrl.unuse()
    }
    lightningUrl.use()
    lightningApplied = true
}

export function getStyle(): PageStyle {
    return currentStyle as PageStyle
}

const settings = getLocalStreamSettings(globalDefaultSettings())

setStyle(settings.pageStyle)
