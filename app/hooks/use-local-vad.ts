"use client";

import { useCallback, useEffect, useRef } from "react";
import { getVadSilenceDurationMs } from "@/lib/local-vad";

const VAD_MIN_RMS = 0.012;
const VAD_NOISE_MULTIPLIER = 2.5;

type UseLocalVadOptions = {
  getActiveSourceText: () => string;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
};

export function useLocalVad({
  getActiveSourceText,
  onSpeechStart,
  onSpeechEnd,
}: UseLocalVadOptions) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const speechDetectedRef = useRef(false);
  const silenceStartedAtRef = useRef<number | null>(null);
  const noiseFloorRef = useRef(0.01);
  const callbacksRef = useRef({ getActiveSourceText, onSpeechStart, onSpeechEnd });

  useEffect(() => {
    callbacksRef.current = { getActiveSourceText, onSpeechStart, onSpeechEnd };
  }, [getActiveSourceText, onSpeechEnd, onSpeechStart]);

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
          callbacksRef.current.onSpeechStart();
        }
        speechDetectedRef.current = true;
        silenceStartedAtRef.current = null;
      } else {
        noiseFloorRef.current += (rms - noiseFloorRef.current) * 0.05;
        if (speechDetectedRef.current) {
          silenceStartedAtRef.current ??= now;
          const silenceDurationMs = getVadSilenceDurationMs(
            callbacksRef.current.getActiveSourceText(),
          );
          if (now - silenceStartedAtRef.current >= silenceDurationMs) {
            callbacksRef.current.onSpeechEnd();
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
  }, []);

  useEffect(() => () => stopLocalVad(), [stopLocalVad]);

  return {
    markSpeechDetected,
    startLocalVad,
    stopLocalVad,
  };
}
