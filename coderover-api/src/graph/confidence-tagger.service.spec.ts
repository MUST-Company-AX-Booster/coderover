import { Test, TestingModule } from '@nestjs/testing';
import {
  ConfidenceTaggerService,
  HYBRID_LOW_AGREEMENT_THRESHOLD,
} from './confidence-tagger.service';

/**
 * Phase 10 B2 — ConfidenceTagger is the only classifier in the system.
 * Producers always call through; they never synthesize tags locally. These
 * tests pin the policy so any future change forces an explicit update here.
 */
describe('ConfidenceTaggerService', () => {
  let service: ConfidenceTaggerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConfidenceTaggerService],
    }).compile();
    service = module.get(ConfidenceTaggerService);
  });

  describe('AST producers', () => {
    it('always classifies AST output as EXTRACTED with score 1.0', () => {
      const result = service.tag({ producer: 'ast:graph-sync', producerKind: 'ast' });
      expect(result.tag).toBe('EXTRACTED');
      expect(result.score).toBe(1.0);
      expect(result.evidence_ref).toBeNull();
    });

    it('ignores a supplied self-score on AST output', () => {
      const result = service.tag({
        producer: 'ast:graph-sync',
        producerKind: 'ast',
        selfScore: 0.2, // deliberately low — should be overridden
      });
      expect(result.tag).toBe('EXTRACTED');
      expect(result.score).toBe(1.0);
    });

    it('passes evidence_ref through verbatim', () => {
      const refs = { srcId: 'abc', dstId: 'def', note: 'AST' };
      const result = service.tag({
        producer: 'ast:graph-sync',
        producerKind: 'ast',
        refs,
      });
      expect(result.evidence_ref).toEqual(refs);
    });
  });

  describe('LLM producers', () => {
    it('classifies LLM output as INFERRED with a valid score', () => {
      const result = service.tag({
        producer: 'hybrid-search',
        producerKind: 'llm',
        selfScore: 0.72,
      });
      expect(result.tag).toBe('INFERRED');
      expect(result.score).toBe(0.72);
    });

    it('clamps a supplied score into [0, 1]', () => {
      const high = service.tag({ producer: 'llm', producerKind: 'llm', selfScore: 1.5 });
      const low = service.tag({ producer: 'llm', producerKind: 'llm', selfScore: -0.3 });
      expect(high.tag).toBe('INFERRED');
      expect(high.score).toBe(1.0);
      expect(low.tag).toBe('INFERRED');
      expect(low.score).toBe(0);
    });

    it('downgrades to AMBIGUOUS when the LLM score is missing', () => {
      const result = service.tag({ producer: 'llm', producerKind: 'llm' });
      expect(result.tag).toBe('AMBIGUOUS');
      expect(result.score).toBeNull();
    });

    it('downgrades to AMBIGUOUS when the LLM score is NaN', () => {
      const result = service.tag({
        producer: 'llm',
        producerKind: 'llm',
        selfScore: Number.NaN,
      });
      expect(result.tag).toBe('AMBIGUOUS');
      expect(result.score).toBeNull();
    });

    it('downgrades to AMBIGUOUS when the LLM score is Infinity', () => {
      const result = service.tag({
        producer: 'llm',
        producerKind: 'llm',
        selfScore: Number.POSITIVE_INFINITY,
      });
      expect(result.tag).toBe('AMBIGUOUS');
      expect(result.score).toBeNull();
    });
  });

  describe('Hybrid producers', () => {
    it('classifies high-agreement hybrid output as INFERRED with the agreement score', () => {
      const result = service.tag({
        producer: 'ast+llm',
        producerKind: 'hybrid',
        selfScore: 0.9,
      });
      expect(result.tag).toBe('INFERRED');
      expect(result.score).toBe(0.9);
    });

    it('classifies low-agreement hybrid output as AMBIGUOUS while preserving the score', () => {
      const below = HYBRID_LOW_AGREEMENT_THRESHOLD - 0.1;
      const result = service.tag({
        producer: 'ast+llm',
        producerKind: 'hybrid',
        selfScore: below,
      });
      expect(result.tag).toBe('AMBIGUOUS');
      expect(result.score).toBe(below);
    });

    it('treats the exact threshold as high-agreement', () => {
      const result = service.tag({
        producer: 'ast+llm',
        producerKind: 'hybrid',
        selfScore: HYBRID_LOW_AGREEMENT_THRESHOLD,
      });
      expect(result.tag).toBe('INFERRED');
    });

    it('treats a missing agreement score as AMBIGUOUS', () => {
      const result = service.tag({
        producer: 'ast+llm',
        producerKind: 'hybrid',
      });
      expect(result.tag).toBe('AMBIGUOUS');
      expect(result.score).toBeNull();
    });
  });

  it('normalizes an omitted refs to null in the return value', () => {
    const result = service.tag({ producer: 'ast', producerKind: 'ast' });
    expect(result.evidence_ref).toBeNull();
  });
});
