"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  getVadSilenceDurationMs,
  SPEECH_CONFIRMATION_MS,
} from "@/lib/local-vad";

const VAD_MIN_RMS = 0.012;
const VAD_NOISE_MULTIPLIER = 2.5;

type UseLocalVadOptions = {
  getActiveSourceText: () => string;
  onSpeechStart: (at: number) => void;
  onSilenceStart: (at: number) => void;
  onSilenceCancel: () => void;
  onSpeechEnd: (at: number) => void;
};

export function useLocalVad({
  getActiveSourceText,
  onSpeechStart,
  onSilenceStart,
  onSilenceCancel,
  onSpeechEnd,
}: UseLocalVadOptions) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const speechDetectedRef = useRef(false);
  const speechCandidateStartedAtRef = useRef<number | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const noiseFloorRef = useRef(0.01);
  const callbacksRef = useRef({
    getActiveSourceText,
    onSpeechStart,
    onSilenceStart,
    onSilenceCancel,
    onSpeechEnd,
  });

  useEffect(() => {
    callbacksRef.current = {
      getActiveSourceText,
      onSpeechStart,
      onSilenceStart,
      onSilenceCancel,
      onSpeechEnd,
    };
  }, [getActiveSourceText, onSilenceCancel, onSilenceStart, onSpeechEnd, onSpeechStart]);

  const stopLocalVad = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = null;

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }

    speechDetectedRef.current = false;
    speechCandidateStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    noiseFloorRef.current = 0.01;
  }, []);

  const startLocalVad = useCallback((sourceStream: MediaStream) => {
    stopLocalVad();

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(sourceStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    audioContextRef.current = audioContext;

    const sampleVoiceActivity = (now: number) => {
      analyser.getFloatTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) sumSquares += sample * sample;
      const rms = Math.sqrt(sumSquares / samples.length);
      const speechThreshold = Math.max(
        VAD_MIN_RMS,
        noiseFloorRef.current * VAD_NOISE_MULTIPLIER,
      );

      if (rms >= speechThreshold) {
        if (!speechDetectedRef.current) {
          speechCandidateStartedAtRef.current ??= now;
          if (
            now - speechCandidateStartedAtRef.current >= SPEECH_CONFIRMATION_MS
          ) {
            callbacksRef.current.onSpeechStart(speechCandidateStartedAtRef.current);
            speechDetectedRef.current = true;
            speechCandidateStartedAtRef.current = null;
          }
        } else if (silenceStartedAtRef.current !== null) {
          callbacksRef.current.onSilenceCancel();
        }
        silenceStartedAtRef.current = null;
      } else {
        speechCandidateStartedAtRef.current = null;
        noiseFloorRef.current += (rms - noiseFloorRef.current) * 0.05;
        if (speechDetectedRef.current) {
          if (silenceStartedAtRef.current === null) {
            silenceStartedAtRef.current = now;
            callbacksRef.current.onSilenceStart(now);
          }
          const silenceDurationMs = getVadSilenceDurationMs(
            callbacksRef.current.getActiveSourceText(),
          );
          if (now - silenceStartedAtRef.current >= silenceDurationMs) {
            callbacksRef.current.onSpeechEnd(now);
            speechDetectedRef.current = false;
            silenceStartedAtRef.current = null;
          }
        }
      }

      animationFrameRef.current = window.requestAnimationFrame(sampleVoiceActivity);
    };

    animationFrameRef.current = window.requestAnimationFrame(sampleVoiceActivity);
  }, [stopLocalVad]);

  const markSpeechDetected = useCallback(() => {
    speechDetectedRef.current = true;
    speechCandidateStartedAtRef.current = null;
  }, []);

  useEffect(() => () => stopLocalVad(), [stopLocalVad]);

  return {
    markSpeechDetected,
    startLocalVad,
    stopLocalVad,
  };
}
