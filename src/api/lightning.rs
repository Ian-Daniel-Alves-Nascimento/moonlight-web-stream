//! Lightning Launcher integration (fork addition).

use actix_web::{
    get,
    web::{Data, Json, Query},
};

use crate::{
    api::bindings::{DisplayMode, GetHostDisplayResponse, GetHostQuery},
    app::{App, AppError, host::HostId, user::AuthenticatedUser},
};

/// Display facts the client needs to pick the resolution it asks for when upscaling:
/// with a virtual display the host renders whatever the client requests, with the physical
/// monitor the host keeps the monitor's resolution.
#[get("/host/display")]
pub async fn get_host_display(
    app: Data<App>,
    mut user: AuthenticatedUser,
    Query(query): Query<GetHostQuery>,
) -> Result<Json<GetHostDisplayResponse>, AppError> {
    let host = user.host(HostId(query.host_id)).await?;
    let address = host.address(&mut user).await?;

    if !is_local_address(&address) {
        return Ok(Json(GetHostDisplayResponse {
            local: false,
            virtual_display: None,
            primary_width: None,
            primary_height: None,
            virtual_modes: Vec::new(),
        }));
    }

    let config_path = app
        .config()
        .lightning
        .sunshine_config_path
        .clone()
        .or_else(default_sunshine_config_path);
    let virtual_display = config_path
        .as_deref()
        .and_then(sunshine_streams_virtual_display);
    let primary = primary_display_resolution();

    let vdd_settings_path = app
        .config()
        .lightning
        .vdd_settings_path
        .clone()
        .unwrap_or_else(|| DEFAULT_VDD_SETTINGS_PATH.to_owned());
    let virtual_modes = std::fs::read_to_string(vdd_settings_path)
        .map(|xml| vdd_resolutions(&xml))
        .unwrap_or_default();

    Ok(Json(GetHostDisplayResponse {
        local: true,
        virtual_display,
        primary_width: primary.map(|(width, _)| width),
        primary_height: primary.map(|(_, height)| height),
        virtual_modes,
    }))
}

/// Where the virtual display driver bundled with the Lightning Launcher keeps its settings.
const DEFAULT_VDD_SETTINGS_PATH: &str = r"C:\VirtualDisplayDriver\vdd_settings.xml";

/// The distinct `<width>`/`<height>` pairs of the virtual display driver's settings, in order.
fn vdd_resolutions(xml: &str) -> Vec<DisplayMode> {
    fn tag_value(text: &str, tag: &str) -> Option<(u32, usize)> {
        let open = format!("<{tag}>");
        let start = text.find(&open)? + open.len();
        let end = start + text[start..].find('<')?;
        Some((text[start..end].trim().parse().ok()?, end))
    }

    let mut modes: Vec<DisplayMode> = Vec::new();
    let mut rest = xml;
    while let Some((width, after_width)) = tag_value(rest, "width") {
        rest = &rest[after_width..];
        let Some((height, after_height)) = tag_value(rest, "height") else {
            break;
        };
        rest = &rest[after_height..];

        if width > 0
            && height > 0
            && !modes
                .iter()
                .any(|mode| mode.width == width && mode.height == height)
        {
            modes.push(DisplayMode { width, height });
        }
    }
    modes
}

fn is_local_address(address: &str) -> bool {
    matches!(
        address.trim().to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

/// Where the Lightning Launcher keeps the Sunshine it bundles.
fn default_sunshine_config_path() -> Option<String> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let path = std::path::Path::new(&local_app_data)
        .join("LightningLauncher")
        .join("Sunshine")
        .join("config")
        .join("sunshine.conf");

    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// Sunshine streams a virtual display when it is set to capture one output and switch every
/// other display off (`dd_configuration_option = ensure_only_display` with an `output_name`).
fn sunshine_streams_virtual_display(config_path: &str) -> Option<bool> {
    let text = std::fs::read_to_string(config_path).ok()?;

    let mut configuration_option = None;
    let mut output_name = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "dd_configuration_option" => configuration_option = Some(value.trim().to_owned()),
            "output_name" => output_name = Some(value.trim().to_owned()),
            _ => {}
        }
    }

    Some(
        configuration_option.as_deref() == Some("ensure_only_display")
            && output_name.is_some_and(|name| !name.is_empty()),
    )
}

#[cfg(windows)]
fn primary_display_resolution() -> Option<(u32, u32)> {
    use windows_sys::Win32::Graphics::Gdi::{
        DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW,
    };

    // SAFETY: DEVMODEW is plain data; zeroed with dmSize set is the documented way to call it.
    let mut mode: DEVMODEW = unsafe { std::mem::zeroed() };
    mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;

    // A null device name means the primary display.
    let ok = unsafe { EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut mode) };

    (ok != 0 && mode.dmPelsWidth > 0 && mode.dmPelsHeight > 0)
        .then_some((mode.dmPelsWidth, mode.dmPelsHeight))
}

#[cfg(not(windows))]
fn primary_display_resolution() -> Option<(u32, u32)> {
    None
}
