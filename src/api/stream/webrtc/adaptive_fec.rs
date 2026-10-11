//! Lightning fork: FlexFEC that follows the network.
//!
//! The encoder (`FlexFec03SendInterceptor`) protects every 5 media packets with 1 repair
//! packet: 20%, all the time. On a clean network that is a fifth of the bandwidth carrying
//! repairs nobody uses (seen live: ~17% of the packets, 0% loss), bandwidth that could carry
//! picture. Its ratio is fixed once built, so this wraps it: while the receiver reports no loss
//! (RTCP receiver reports and NACKs, read here on their way in), only 1 repair packet in
//! `KEEP_ONE_IN` goes out (~5%); at the first sign of loss, all of them go out again and keep
//! going until the network has been clean for `LOSS_HOLD`.

use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use rtc::{
    interceptor::{self, FlexFec03SendInterceptor, Interceptor, StreamInfo, TaggedPacket},
    rtcp::{
        receiver_report::ReceiverReport, sender_report::SenderReport,
        transport_feedbacks::transport_layer_nack::TransportLayerNack,
    },
    sansio::Protocol,
};

/// Clean for this long after the last loss before the protection is lowered
const LOSS_HOLD: Duration = Duration::from_secs(5);
/// Full protection at the start, until the first reports tell how the network is
const START_HOLD: Duration = Duration::from_secs(3);
/// While clean: 1 of every this many repair packets is sent
const KEEP_ONE_IN: u64 = 4;

pub struct AdaptiveFecInterceptor {
    inner: FlexFec03SendInterceptor,
    fec_payload_type: u8,
    /// The repair stream's SSRC, learned from the first repair packet: losses the browser reports
    /// on IT are the repairs this leaves home, not the network
    fec_ssrc: Option<u32>,
    started: Option<Instant>,
    last_loss: Option<Instant>,
    repairs: u64,
    read_queue: VecDeque<TaggedPacket>,
}

impl AdaptiveFecInterceptor {
    pub fn new(inner: FlexFec03SendInterceptor, fec_payload_type: u8) -> Self {
        Self {
            inner,
            fec_payload_type,
            fec_ssrc: None,
            started: None,
            last_loss: None,
            repairs: 0,
            read_queue: VecDeque::new(),
        }
    }

    fn network_clean(&self, now: Instant) -> bool {
        let Some(started) = self.started else {
            return false;
        };
        if now.saturating_duration_since(started) < START_HOLD {
            return false;
        }
        self.last_loss
            .is_none_or(|loss| now.saturating_duration_since(loss) >= LOSS_HOLD)
    }

    fn note_feedback(&mut self, msg: &TaggedPacket) {
        let interceptor::Packet::Rtcp(packets) = &msg.message.packet else {
            return;
        };
        for packet in packets {
            let any = packet.as_any();
            let media = |ssrc: u32| Some(ssrc) != self.fec_ssrc;
            let lost = if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
                rr.reports
                    .iter()
                    .any(|report| media(report.ssrc) && report.fraction_lost > 0)
            } else if let Some(sr) = any.downcast_ref::<SenderReport>() {
                sr.reports
                    .iter()
                    .any(|report| media(report.ssrc) && report.fraction_lost > 0)
            } else if let Some(nack) = any.downcast_ref::<TransportLayerNack>() {
                media(nack.media_ssrc)
            } else {
                false
            };
            if lost {
                self.last_loss = Some(msg.now);
            }
        }
    }
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for AdaptiveFecInterceptor {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = webrtc::error::Error;
    type Time = Instant;

    fn handle_read(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.note_feedback(&msg);
        self.inner.handle_read(msg)?;
        while let Some(out) = self.inner.poll_read() {
            self.read_queue.push_back(out);
        }
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read_queue.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.started.get_or_insert(msg.now);
        self.inner.handle_write(msg)
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        loop {
            let packet = self.inner.poll_write()?;
            let interceptor::Packet::Rtp(rtp) = &packet.message.packet else {
                return Some(packet);
            };
            if rtp.header.payload_type != self.fec_payload_type {
                return Some(packet);
            }
            self.fec_ssrc.get_or_insert(rtp.header.ssrc);
            self.repairs += 1;
            if self.network_clean(packet.now) && self.repairs % KEEP_ONE_IN != 0 {
                // Clean network: this repair packet stays home
                continue;
            }
            return Some(packet);
        }
    }

    fn handle_timeout(&mut self, now: Instant) -> Result<(), Self::Error> {
        self.inner.handle_timeout(now)
    }

    fn poll_timeout(&mut self) -> Option<Self::Time> {
        self.inner.poll_timeout()
    }
}

impl Interceptor for AdaptiveFecInterceptor {
    fn bind_local_stream(&mut self, info: &StreamInfo) {
        self.inner.bind_local_stream(info)
    }
    fn unbind_local_stream(&mut self, info: &StreamInfo) {
        self.inner.unbind_local_stream(info)
    }
    fn bind_remote_stream(&mut self, info: &StreamInfo) {
        self.inner.bind_remote_stream(info)
    }
    fn unbind_remote_stream(&mut self, info: &StreamInfo) {
        self.inner.unbind_remote_stream(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::{
        interceptor::{AttributedPacket, FlexFec03SendBuilder, Packet},
        rtcp::reception_report::ReceptionReport,
        rtp,
        shared::TransportContext,
    };

    const SSRC: u32 = 1111;
    const FEC_SSRC: u32 = 2222;
    const FEC_PT: u8 = 49;

    fn interceptor() -> AdaptiveFecInterceptor {
        let mut fec = AdaptiveFecInterceptor::new(
            FlexFec03SendBuilder::default()
                .with_num_media_packets(5)
                .with_num_fec_packets(1)
                .build(),
            FEC_PT,
        );
        fec.bind_local_stream(&StreamInfo {
            ssrc: SSRC,
            ssrc_fec: Some(FEC_SSRC),
            payload_type_fec: Some(FEC_PT),
            clock_rate: 90_000,
            mime_type: "video/H264".to_owned(),
            payload_type: 96,
            ..Default::default()
        });
        fec
    }

    /// Sends `count` media packets from `seq`, `at` the given instant; returns the repair packets
    /// that went out
    fn send(fec: &mut AdaptiveFecInterceptor, at: Instant, seq: &mut u16, count: u16) -> usize {
        let mut repairs = 0;
        for _ in 0..count {
            fec.handle_write(TaggedPacket {
                now: at,
                transport: TransportContext::default(),
                message: AttributedPacket::new(Packet::Rtp(rtp::Packet {
                    header: rtp::header::Header {
                        version: 2,
                        payload_type: 96,
                        sequence_number: *seq,
                        timestamp: u32::from(*seq) * 750,
                        ssrc: SSRC,
                        ..Default::default()
                    },
                    payload: vec![0xAB; 1000].into(),
                    ..Default::default()
                })),
            })
            .expect("write");
            *seq = seq.wrapping_add(1);
            while let Some(out) = fec.poll_write() {
                if let Packet::Rtp(p) = &out.message.packet {
                    if p.header.payload_type == FEC_PT {
                        repairs += 1;
                    }
                }
            }
        }
        repairs
    }

    fn report(fec: &mut AdaptiveFecInterceptor, at: Instant, ssrc: u32, fraction_lost: u8) {
        let rr = ReceiverReport {
            ssrc: 9,
            reports: vec![ReceptionReport {
                ssrc,
                fraction_lost,
                ..Default::default()
            }],
            ..Default::default()
        };
        fec.handle_read(TaggedPacket {
            now: at,
            transport: TransportContext::default(),
            message: AttributedPacket::new(Packet::Rtcp(vec![Box::new(rr)])),
        })
        .expect("read");
        while fec.poll_read().is_some() {}
    }

    #[test]
    fn full_at_start_lower_when_clean_full_again_on_loss() {
        let mut fec = interceptor();
        let epoch = Instant::now();
        let mut seq = 0u16;

        // Start: 20% (1 per 5), the network is not known yet
        assert_eq!(20, send(&mut fec, epoch, &mut seq, 100));

        // Clean for long enough: 1 repair in 4 → 5 of 20
        let clean = epoch + Duration::from_secs(4);
        report(&mut fec, clean, SSRC, 0);
        assert_eq!(5, send(&mut fec, clean, &mut seq, 100));

        // Loss on the MEDIA stream: back to 20%...
        let lossy = clean + Duration::from_secs(1);
        report(&mut fec, lossy, SSRC, 12);
        assert_eq!(20, send(&mut fec, lossy, &mut seq, 100));
        // ...and stays there until it has been clean for LOSS_HOLD
        assert_eq!(
            20,
            send(&mut fec, lossy + Duration::from_secs(4), &mut seq, 100)
        );
        assert_eq!(
            5,
            send(&mut fec, lossy + Duration::from_secs(6), &mut seq, 100)
        );

        // "Loss" on the repair stream itself is the repairs left home, not the network
        let later = lossy + Duration::from_secs(7);
        report(&mut fec, later, FEC_SSRC, 200);
        assert_eq!(5, send(&mut fec, later, &mut seq, 100));
    }

    #[test]
    fn nack_on_media_counts_as_loss() {
        let mut fec = interceptor();
        let epoch = Instant::now();
        let mut seq = 0u16;
        send(&mut fec, epoch, &mut seq, 10);
        let at = epoch + Duration::from_secs(10);
        let nack = TransportLayerNack {
            sender_ssrc: 9,
            media_ssrc: SSRC,
            nacks: vec![],
        };
        fec.handle_read(TaggedPacket {
            now: at,
            transport: TransportContext::default(),
            message: AttributedPacket::new(Packet::Rtcp(vec![Box::new(nack)])),
        })
        .expect("read");
        while fec.poll_read().is_some() {}
        assert_eq!(20, send(&mut fec, at, &mut seq, 100));
    }
}
