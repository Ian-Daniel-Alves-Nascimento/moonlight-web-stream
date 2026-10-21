//! Lightning fork: "view only" streams, for a spectator who watches but neither controls the
//! host nor hears it. Turned on by `X-Lightning-View-Only: 1` on the request that creates the
//! WebRTC stream (the Lightning Launcher's bridge sets it; this server only listens on
//! localhost). Such a stream relays no input from the browser except the stream's own
//! protocol packets, sends no audio and never turns the microphone on.

use actix_web::HttpRequest;
use moonlight_common::stream::proto::control::packet::ControlPacket;

pub const VIEW_ONLY_HEADER: &str = "X-Lightning-View-Only";

pub fn requested(req: &HttpRequest) -> bool {
    req.headers()
        .get(VIEW_ONLY_HEADER)
        .is_some_and(|value| value.as_bytes() == b"1")
}

/// The packets that keep the stream itself working. An allow list: input of any kind, and any
/// packet type a future protocol version adds, is not relayed for a view-only stream.
pub fn is_protocol_packet(packet: &ControlPacket) -> bool {
    matches!(
        packet,
        ControlPacket::RequestIdr
            | ControlPacket::StartB
            | ControlPacket::PeriodicPing
            | ControlPacket::LossStats { .. }
            | ControlPacket::FrameStats { .. }
            | ControlPacket::FrameFec { .. }
            | ControlPacket::InvalidateReferenceFrames { .. }
            | ControlPacket::LongTermReferenceFrameAcknowledgement { .. }
            | ControlPacket::HdrMode { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;
    use moonlight_common::stream::control::{
        ActiveGamepads, KeyAction, KeyCode, KeyFlags, KeyModifiers,
    };

    #[test]
    fn only_the_header_with_1_turns_it_on() {
        assert!(requested(
            &TestRequest::default()
                .insert_header((VIEW_ONLY_HEADER, "1"))
                .to_http_request()
        ));
        assert!(!requested(
            &TestRequest::default()
                .insert_header((VIEW_ONLY_HEADER, "0"))
                .to_http_request()
        ));
        assert!(!requested(&TestRequest::default().to_http_request()));
    }

    #[test]
    fn input_is_not_protocol() {
        assert!(is_protocol_packet(&ControlPacket::RequestIdr));
        assert!(!is_protocol_packet(&ControlPacket::Keyboard {
            action: KeyAction::Down,
            flags: KeyFlags::empty(),
            key_code: KeyCode::VK_LWIN,
            modifiers: KeyModifiers::empty(),
            zero: 0,
        }));
        assert!(!is_protocol_packet(&ControlPacket::ControllerState {
            header_b: 0,
            controller_number: 0,
            active_gamepad_mask: ActiveGamepads::from_bits_truncate(1),
            mid_b: 0,
            button_flags: 0x1000,
            left_trigger: 0,
            right_trigger: 0,
            left_stick_x: 0,
            left_stick_y: 0,
            right_stick_x: 0,
            right_stick_y: 0,
            tail_a: 0,
            button_flags_2: 0,
            tail_b: 0,
        }));
    }
}
