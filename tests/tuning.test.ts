import { describe, expect, it } from 'vitest'
import { tuning } from '../src/game/tuning'

describe('3D 보드 미리보기 설정', () => {
  it('현재 사용하지 않는 액션게임 전용 설정은 노출하지 않는다', () => {
    expect(tuning.controls).toEqual([])
    expect(tuning.read()).toEqual({ requested: {}, active: {} })
    expect(tuning.unranked).toBe(false)
  })
  it('정의되지 않은 조정 값은 거부한다', () => {
    expect(() => tuning.apply({})).not.toThrow()
    expect(() => tuning.apply({ unknown: 1 })).toThrow()
    expect(() => tuning.apply(null)).toThrow()
  })
})
