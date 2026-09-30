import { en, type Translations } from "./locales/en"
import { zhCN } from "./locales/zh-CN"
import { ptBR } from "./locales/pt-BR"
import { frFr } from "./locales/fr-FR"
import { koKR } from "./locales/ko-KR"

export type Language = "en" | "zh-CN" | "pt-BR" | "fr-FR" | "ko-KR"

// Translations is defined in locales/en.ts (the canonical locale).
// Adding a new locale requires: (1) create web/locales/<code>.ts implementing
// Translations, (2) add it to the Language union and the locales map below.
export type { Translations }

const locales: Record<Language, Translations> = {
    "en": en,
    "zh-CN": zhCN,
    "pt-BR": ptBR,
    "fr-FR": frFr,
    "ko-KR": koKR,
}

export function getTranslations(language: Language): Translations {
    return locales[language]
}

/// Lightning fork: the language setting can also be "auto" (follow the device), the default.
export type LanguageSetting = Language | "auto"

export function normalizeLanguage(language: unknown): Language {
    if (language == null || language === "auto") {
        return detectDeviceLanguage()
    }
    return matchLanguage(language) ?? "en"
}

function matchLanguage(language: unknown): Language | null {
    if (typeof language != "string") {
        return null
    }
    const code = language.toLowerCase().replace("_", "-")
    if (code == "zh" || code.startsWith("zh-")) {
        return "zh-CN"
    }
    if (code == "pt" || code.startsWith("pt-")) {
        return "pt-BR"
    }
    if (code == "ko" || code.startsWith("ko-")) {
        return "ko-KR"
    }
    if (code == "fr" || code.startsWith("fr-")) {
        return "fr-FR"
    }
    if (code == "en" || code.startsWith("en-")) {
        return "en"
    }
    return null
}

function detectDeviceLanguage(): Language {
    const languages = typeof navigator != "undefined" ? (navigator.languages ?? [navigator.language]) : []
    for (const language of languages) {
        const match = matchLanguage(language)
        if (match) {
            return match
        }
    }
    return "en"
}

function getStoredSettings(): Record<string, unknown> | null {
    try {
        const raw = localStorage.getItem("mlSettings")
        return raw ? JSON.parse(raw) : null
    } catch {
        return null
    }
}

export function getCurrentLanguage(): Language {
    return normalizeLanguage(getStoredSettings()?.language)
}

export function hasStoredLanguage(): boolean {
    return getStoredSettings()?.language != null
}

export function adoptRoleDefaultLanguage(roleDefaultSettings: { language?: unknown } | null | undefined): boolean {
    if (hasStoredLanguage()) {
        return false
    }
    // "auto" keeps following the device, nothing to pin locally
    if (roleDefaultSettings?.language == null || roleDefaultSettings.language === "auto") {
        return false
    }

    const roleLanguage = normalizeLanguage(roleDefaultSettings?.language)
    if (roleLanguage === getCurrentLanguage()) {
        return false
    }

    try {
        const settings = getStoredSettings() ?? {}
        settings.language = roleLanguage
        localStorage.setItem("mlSettings", JSON.stringify(settings))
        return true
    } catch {
        localStorage.setItem("mlSettings", JSON.stringify({ language: roleLanguage }))
        return true
    }
}

export function getLanguageOptions(autoName: string): Array<{ value: LanguageSetting, name: string }> {
    return [
        { value: "auto", name: autoName },
        { value: "en", name: "English" },
        { value: "zh-CN", name: "中文" },
        { value: "pt-BR", name: "Português (Brasil)" },
        { value: "fr-FR", name: "Français" },
        { value: "ko-KR", name: "한국어" },
    ]
}
