import { describe, it, expect } from 'vitest';
import {
  RegisterSchema, LoginSchema, PlaceOrderSchema, BorrowSchema,
  RepaySchema, ShiftSchema, EnrollSchema, ChangePasswordSchema,
} from '@pt/shared';

describe('shared zod schemas', () => {
  it('RegisterSchema 接受合法用户名/密码', () => {
    expect(RegisterSchema.safeParse({ username: '布偶ab_1', password: 'p@ssw0rd!' }).success).toBe(true);
  });
  it('RegisterSchema 拒绝非法字符与超短密码', () => {
    expect(RegisterSchema.safeParse({ username: 'a', password: 'p@ssw0rd!' }).success).toBe(false);
    expect(RegisterSchema.safeParse({ username: 'ok名字', password: 'short' }).success).toBe(false);
    expect(RegisterSchema.safeParse({ username: 'bad name!', password: 'p@ssw0rd!' }).success).toBe(false);
  });
  it('LoginSchema 与 RegisterSchema 同形', () => {
    expect(LoginSchema).toBe(RegisterSchema);
  });
  it('PlaceOrderSchema: L 必填 price、M 必空', () => {
    const base = { code: '600001', side: 'B', qty: 100, clientKey: 'k1' };
    expect(PlaceOrderSchema.safeParse({ ...base, type: 'L', price: 1234 }).success).toBe(true);
    expect(PlaceOrderSchema.safeParse({ ...base, type: 'L' }).success).toBe(false);
    expect(PlaceOrderSchema.safeParse({ ...base, type: 'M' }).success).toBe(true);
    expect(PlaceOrderSchema.safeParse({ ...base, type: 'M', price: 1234 }).success).toBe(false);
  });
  it('PlaceOrderSchema 拒绝非 6 位代码与非整数价', () => {
    expect(PlaceOrderSchema.safeParse({ code: '60001', side: 'B', type: 'M', qty: 100, clientKey: 'k' }).success).toBe(false);
    expect(PlaceOrderSchema.safeParse({ code: '600001', side: 'S', type: 'L', price: 12.5, qty: 100, clientKey: 'k' }).success).toBe(false);
  });
  it('Borrow/Repay/Shift/Enroll/ChangePassword 基本校验', () => {
    expect(BorrowSchema.safeParse({ amount: 100, termDays: 20 }).success).toBe(true);
    expect(BorrowSchema.safeParse({ amount: -1, termDays: 20 }).success).toBe(false);
    expect(RepaySchema.safeParse({ amount: 100 }).success).toBe(true);
    expect(RepaySchema.safeParse({ amount: 0 }).success).toBe(false);
    expect(ShiftSchema.safeParse({ jobId: 3 }).success).toBe(true);
    expect(EnrollSchema.safeParse({ ability: 'FIT' }).success).toBe(true);
    expect(EnrollSchema.safeParse({ ability: 'XYZ' }).success).toBe(false);
    expect(ChangePasswordSchema.safeParse({ oldPassword: 'oldpass99', newPassword: 'newpass99' }).success).toBe(true);
    expect(ChangePasswordSchema.safeParse({ oldPassword: 'oldpass99', newPassword: 'short' }).success).toBe(false);
  });
});
