const info = AFRAME.utils.debug('ARENA:webrtc-stats:info');

export default class WebRTCStatsLogger {
    constructor(peerConnection, signaler, logToConsole = true) {
        this.peerConnection = peerConnection;
        this.signaler = signaler;
        this.logToConsole = logToConsole;

        this.lastReport = null;
        this._lastPacketsLost = 0;
        this._lastPacketsReceived = 0;
        this._smoothedLoss = 0;
    }

    async getStats(additionalStats) {
        // v10: 增加空检查，防止 PC 被关闭后调用 getStats 抛异常
        if (!this.peerConnection) {
            return;
        }
        try {
            const report = await this.peerConnection.getStats();
            this.handleReport(report, additionalStats);
        } catch (err) {
            console.warn('[WebRTCStatsLogger] getStats failed:', err);
        }
    }

    handleReport(report, additionalStats) {
        const safeAdditionalStats = additionalStats || {};
        // v10: 如果 signaler 已不可用（如重连期间），跳过本次上报
        if (!this.signaler) {
            return;
        }

        report.forEach((stat) => {
            if (stat.type !== 'inbound-rtp') {
                return;
            }

            if (this.logToConsole) {
                if (stat.codecId !== undefined) {
                    const codec = report.get(stat.codecId);
                    info(`Codec: ${codec.mimeType}`);

                    if (codec.payloadType) {
                        info(`payloadType=${codec.payloadType}`);
                    }

                    if (codec.clockRate) {
                        info(`clockRate=${codec.clockRate}`);
                    }

                    if (codec.channels) {
                        info(`channels=${codec.channels}`);
                    }
                }

                if (stat.kind === 'video') {
                    info(`Decoder: ${stat.decoderImplementation}`);
                    info(`Resolution: ${stat.frameWidth}x${stat.frameHeight}`);
                    info(`Framerate: ${stat.framesPerSecond}`);

                    if (this.lastReport && this.lastReport.has(stat.id)) {
                        const lastStats = this.lastReport.get(stat.id);
                        if (stat.totalDecodeTime) {
                            info(`Decode Time: ${(stat.totalDecodeTime - lastStats.totalDecodeTime).toFixed(3)}`);
                        }

                        if (stat.totalInterFrameDelay) {
                            info(
                                `InterFrame Delay: ${(
                                    stat.totalInterFrameDelay - lastStats.totalInterFrameDelay
                                ).toFixed(3)}`
                            );
                        }

                        if (stat.jitterBufferDelay) {
                            info(
                                `Jitter Buffer Delay: ${(stat.jitterBufferDelay - lastStats.jitterBufferDelay).toFixed(
                                    3
                                )}`
                            );
                            info(
                                `Avg Jitter Buffer Delay: ${(
                                    stat.jitterBufferDelay / stat.jitterBufferEmittedCount
                                ).toFixed(3)}`
                            );
                        }

                        if (stat.totalProcessingDelay) {
                            info(
                                `Total Delay: ${(stat.totalProcessingDelay - lastStats.totalProcessingDelay).toFixed(
                                    3
                                )}`
                            );
                            info(`Avg Delay: ${(stat.totalProcessingDelay / stat.framesDecoded).toFixed(3)}`);
                        }
                    }
                }

                if (this.lastReport && this.lastReport.has(stat.id)) {
                    const lastStats = this.lastReport.get(stat.id);
                    const duration = (stat.timestamp - lastStats.timestamp) / 1000;
                    const bitrate = (8 * (stat.bytesReceived - lastStats.bytesReceived)) / duration / 1000;
                    info(`Bitrate: ${bitrate.toFixed(3)} kbit/sec`);

                    // eslint-disable-next-line no-param-reassign
                    stat.bitrate = bitrate;
                }
            }

            Object.keys(safeAdditionalStats).forEach((key) => {
                // eslint-disable-next-line no-param-reassign
                stat[key] = safeAdditionalStats[key];
            });

            if (stat.latency) {
                info(`E2E Latency: ${stat.latency} ms`);
            }

            const jitterMs = (stat.jitter !== undefined && stat.jitter !== null)
                ? stat.jitter * 1000
                : 0;

            if (this.lastReport && this.lastReport.has(stat.id)) {
                const lastStats = this.lastReport.get(stat.id);

                const dLost = stat.packetsLost - lastStats.packetsLost;
                const dRecv = stat.packetsReceived - lastStats.packetsReceived;
                const effectiveLost = Math.max(0, dLost);
                const dTotal = effectiveLost + Math.max(0, dRecv);

                let packetLossPercent = 0;
                if (dTotal > 0) {
                    packetLossPercent = (effectiveLost / dTotal) * 100;
                }
                packetLossPercent = Math.min(100, packetLossPercent);

                const totalPackets = (stat.packetsLost || 0) + (stat.packetsReceived || 0);
                const totalPacketLossPercent = totalPackets > 0
                    ? Math.min(100, ((stat.packetsLost || 0) / totalPackets) * 100)
                    : 0;

                this._smoothedLoss = 0.3 * packetLossPercent + 0.7 * this._smoothedLoss;
                const smoothedLossPercent = Math.min(100, this._smoothedLoss);

                const nackDelta = Math.max(0, (stat.nackCount || 0) - (lastStats.nackCount || 0));

                const statsIntervalMs = stat.timestamp - lastStats.timestamp;
                const deltaPacketsLost = effectiveLost;
                const deltaPacketsReceived = Math.max(0, dRecv);

                const computedStats = {
                    ...stat,
                    statsSchemaVersion: 2,
                    downlinkKbps: stat.bitrate || 0,
                    packetLossPercent,
                    smoothedLossPercent,
                    totalPacketLossPercent,
                    nackDelta,
                    jitterMs,
                    statsIntervalMs,
                    deltaPacketsLost,
                    deltaPacketsReceived,
                };

                this.signaler.sendStats(computedStats);
            } else {
                this._smoothedLoss = 0;
                this.signaler.sendStats({
                    ...stat,
                    statsSchemaVersion: 2,
                    downlinkKbps: stat.bitrate || 0,
                    packetLossPercent: 0,
                    smoothedLossPercent: 0,
                    totalPacketLossPercent: 0,
                    nackDelta: 0,
                    jitterMs,
                    statsIntervalMs: 0,
                    deltaPacketsLost: 0,
                    deltaPacketsReceived: 0,
                });
            }
        });

        this.lastReport = report;
    }
}
