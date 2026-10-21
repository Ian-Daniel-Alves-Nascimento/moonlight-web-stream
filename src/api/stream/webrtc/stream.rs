use std::{
    future::pending,
    sync::Arc,
    time::{Duration, Instant},
};

use moonlight_common::stream::{
    control::{
        CompactKeyStates, KeyAction, KeyCode, KeyFlags, KeyModifiers, MouseButton,
        MouseButtonAction,
    },
    proto::{
        audio::AudioStreamEvent,
        control::{ControlStreamEvent, packet::ControlPacket},
        video::VideoStreamEvent,
    },
    tokio::{MoonlightStream, MoonlightStreamEvent},
};
use tokio::{select, sync::mpsc, time::sleep_until};
use tracing::{debug, info, warn};
use webrtc::{
    data_channel::DataChannel,
    peer_connection::{PeerConnection, RTCPeerConnectionState},
};

use crate::{
    api::stream::webrtc::{
        WebRtcHandler,
        audio::AudioChannel,
        control::{ControlChannel, ControlChannelEvent},
        video::{VideoChannel, VideoChannelEvent},
        view_only::is_protocol_packet,
    },
    app::AppError,
};

/// Lightning fork: at most one key frame per this interval for the browser's requests (PLI).
/// A key frame is many times a normal frame; on a lossy Wi-Fi it causes more loss, which asked
/// for another one: a cascade of stalls. Requests inside the window become one, sent when it ends.
const CLIENT_IDR_MIN_INTERVAL: Duration = Duration::from_millis(500);

pub async fn webrtc_loop(
    mut stream: MoonlightStream,
    _peer: &dyn PeerConnection,
    mut audio_channel: AudioChannel,
    mut video_channel: VideoChannel,
    mut control_channel: ControlChannel,
    mut on_data_channel: mpsc::UnboundedReceiver<Arc<dyn DataChannel>>,
    handler: &WebRtcHandler,
    view_only: bool,
) -> Result<(), AppError> {
    info!(view_only, "started main webrtc loop");

    let mut last_key_states_sequence_number = 0;
    let mut last_key_states = CompactKeyStates::default();

    let mut moonlight_disconnected = false;
    let mut peer_was_disconnected = true;
    let mut last_client_idr: Option<Instant> = None;
    let mut client_idr_pending = false;
    loop {
        if !stream.is_alive() {
            info!("stopping stream because the moonlight stream is dead");
            break;
        }

        let peer_state = { *handler.peer_state.lock().expect("lock peer state") };

        match peer_state {
            RTCPeerConnectionState::Connected => {
                if peer_was_disconnected {
                    // request idr after connecting
                    debug!("requesting idr after webrtc peers connected");
                    if let Err(err) = stream.send_raw(ControlPacket::RequestIdr) {
                        warn!(error = %err, "failed to request initial idr");
                    }
                    last_client_idr = Some(Instant::now());
                }
                peer_was_disconnected = false;
            }
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                let _ = stream.disconnect();
                moonlight_disconnected = true;
            }
            _ => {
                peer_was_disconnected = true;
            }
        }

        // When the coalesced key frame request is due (only while one is pending)
        let idr_due = last_client_idr
            .map(|t| t + CLIENT_IDR_MIN_INTERVAL)
            .unwrap_or_else(Instant::now);

        select! {
            _ = sleep_until(idr_due.into()), if client_idr_pending => {
                debug!("sending the key frame request held back by the interval");
                if let Err(err) = stream.send_raw(ControlPacket::RequestIdr) {
                    warn!(error = %err, "failed to send idr");
                }
                last_client_idr = Some(Instant::now());
                client_idr_pending = false;
            }
            Some(data_channel) = async { if on_data_channel.is_closed() { pending().await } else { on_data_channel.recv().await } } => {
                let label = data_channel.label().await?;
                debug!(data_channel = ?label, "got data channel");

                if control_channel.try_add_channel(&label, &data_channel) {
                    continue;
                }
            }
            result = stream.drive() => {
                if moonlight_disconnected {
                    continue;
                }

                let event = result?;

                match event {
                    MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(frame)) => {
                        if !matches!(peer_state, RTCPeerConnectionState::Connected) {
                            continue;
                        }

                        // Lightning fork: a view-only stream sends no audio (view_only.rs)
                        if !view_only {
                            audio_channel.on_frame(frame);
                        }
                    }
                    MoonlightStreamEvent::Video(VideoStreamEvent::SignalIdr) => {
                        debug!("requesting idr on behalf of the video stream (packet loss likely)");
                        if let Err(err) = stream.send_raw(ControlPacket::RequestIdr) {
                            warn!(error = %err, "failed to send idr");
                        }
                    }
                    MoonlightStreamEvent::Video(VideoStreamEvent::OnFrame(frame)) => {
                        if !matches!(peer_state, RTCPeerConnectionState::Connected) {
                            continue;
                        }

                        video_channel.on_frame(frame);
                    }
                    MoonlightStreamEvent::Control(ControlStreamEvent::Packet(packet)) => {
                        if let ControlPacket::HdrMode { enabled, sunshine } = &packet {
                            video_channel.set_hdr_enabled(*enabled, *sunshine);
                        }

                        control_channel.send(packet);
                    }
                    _ => {}
                }
            }
            result = video_channel.drive() => {
                let event = result?;

                match event {
                    VideoChannelEvent::SignalIdr => {
                        let now = Instant::now();
                        let allowed = last_client_idr
                            .is_none_or(|t| now.duration_since(t) >= CLIENT_IDR_MIN_INTERVAL);
                        if allowed {
                            debug!("requesting idr because the webrtc client requested it");
                            if let Err(err) = stream.send_raw(ControlPacket::RequestIdr) {
                                warn!(error = %err, "failed to send idr");
                            }
                            last_client_idr = Some(now);
                            client_idr_pending = false;
                        } else {
                            // One more inside the window: becomes the single request at its end
                            client_idr_pending = true;
                        }
                    }
                }
            }
            result = control_channel.drive() => {
                let event = result?;

                // Lightning fork: a view-only stream relays no input (view_only.rs)
                if view_only
                    && let ControlChannelEvent::Packet(packet) = &event
                    && !is_protocol_packet(packet)
                {
                    continue;
                }

                match event {
                    ControlChannelEvent::Packet(ControlPacket::WebState { sequence_number, keys }) => {
                        // The server doesn't support this packet, so we must remove it
                        if sequence_number <= last_key_states_sequence_number && sequence_number.abs_diff(last_key_states_sequence_number) < 1000 {
                            // packets can be dropped when the sequence number is larger than the last the sequence number
                            // and when the sequence number doesn't change dramatically
                            continue;
                        }
                        last_key_states_sequence_number = sequence_number;

                        let modifiers = extract_modifiers(keys);

                        // Find newly pressed keys
                        for changed_key in (keys & !last_key_states).pressed_iter() {
                            send_key_change(&mut stream, modifiers, changed_key, KeyAction::Down);
                        }

                        // Find newly released keys
                        for changed_key in (last_key_states & !keys).pressed_iter() {
                            send_key_change(&mut stream, modifiers, changed_key, KeyAction::Up);
                        }

                        // Update last keys
                        last_key_states = keys;

                        continue;
                    }
                    ControlChannelEvent::Packet(packet) => {
                        if let Err(err) = stream.send_raw(packet) {
                            warn!(error = %err, "failed to relay webrtc client packet to server");
                        }
                    },
                    ControlChannelEvent::Closed => {
                        info!("control channel closed");
                    },
                }
            }
        }
    }

    Ok(())
}

fn send_key_change(
    stream: &mut MoonlightStream,
    modifiers: KeyModifiers,
    key_code: KeyCode,
    action: KeyAction,
) {
    let mouse_button = match key_code {
        KeyCode::VK_LBUTTON => Some(MouseButton::Left),
        KeyCode::VK_MBUTTON => Some(MouseButton::Middle),
        KeyCode::VK_RBUTTON => Some(MouseButton::Right),
        KeyCode::VK_XBUTTON1 => Some(MouseButton::X1),
        KeyCode::VK_XBUTTON2 => Some(MouseButton::X2),
        _ => None,
    };

    let packet = if let Some(button) = mouse_button {
        let action = if action == KeyAction::Down {
            MouseButtonAction::Press
        } else {
            MouseButtonAction::Release
        };

        ControlPacket::MouseButton { action, button }
    } else {
        ControlPacket::Keyboard {
            action,
            flags: KeyFlags::empty(),
            key_code,
            modifiers,
            zero: 0,
        }
    };

    if let Err(err) = stream.send_raw(packet) {
        warn!(error = %err, "failed to send control packet");
    }
}

fn extract_modifiers(key_states: CompactKeyStates) -> KeyModifiers {
    // Get current modifiers
    let mut modifiers = KeyModifiers::empty();

    if key_states.is_pressed(KeyCode::VK_SHIFT).expect("shift key") == KeyAction::Down
        || key_states
            .is_pressed(KeyCode::VK_LSHIFT)
            .expect("left shift key")
            == KeyAction::Down
        || key_states
            .is_pressed(KeyCode::VK_RSHIFT)
            .expect("right shift key")
            == KeyAction::Down
    {
        modifiers |= KeyModifiers::SHIFT;
    }

    if key_states
        .is_pressed(KeyCode::VK_CONTROL)
        .expect("control key")
        == KeyAction::Down
        || key_states
            .is_pressed(KeyCode::VK_LCONTROL)
            .expect("left control key")
            == KeyAction::Down
        || key_states
            .is_pressed(KeyCode::VK_RCONTROL)
            .expect("right control key")
            == KeyAction::Down
    {
        modifiers |= KeyModifiers::CTRL;
    }

    if key_states.is_pressed(KeyCode::VK_MENU).expect("alt key") == KeyAction::Down
        || key_states
            .is_pressed(KeyCode::VK_LMENU)
            .expect("left alt key")
            == KeyAction::Down
        || key_states
            .is_pressed(KeyCode::VK_RMENU)
            .expect("right alt key")
            == KeyAction::Down
    {
        modifiers |= KeyModifiers::ALT;
    }

    if key_states
        .is_pressed(KeyCode::VK_LWIN)
        .expect("left windows key")
        == KeyAction::Down
        || key_states
            .is_pressed(KeyCode::VK_RWIN)
            .expect("right windows key")
            == KeyAction::Down
    {
        modifiers |= KeyModifiers::META;
    }

    modifiers
}
