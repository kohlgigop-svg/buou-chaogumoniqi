import { z } from 'zod';

// —— auth ——
export const RegisterSchema = z.object({
  username: z.string().min(2).max(16).regex(/^[\w\u4e00-\u9fa5]+$/),
  password: z.string().min(8).max(72),
});
export const LoginSchema = RegisterSchema;                     // 同形
export const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(8),
  newPassword: z.string().min(8).max(72),
});

// —— trading ——
export const PlaceOrderSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  side: z.enum(['B', 'S']),
  type: z.enum(['L', 'M']),
  price: z.number().int().positive().optional(),               // 分；L 必填、M 必空（refine）
  qty: z.number().int().positive(),
  clientKey: z.string().min(1).max(64),
}).refine(o => o.type === 'L' ? o.price !== undefined : o.price === undefined);

// —— bank ——
export const BorrowSchema = z.object({ amount: z.number().int().positive(), termDays: z.number().int() });
export const RepaySchema = z.object({ amount: z.number().int().positive() });

// —— P2P（玩家间借贷）——
// amount 单位统一为**分**（与站内所有金额一致）。
export const P2pProposeSchema = z.object({
  /** 'borrow' = 我要借钱（对手方是出借人）；'lend' = 我要放贷（对手方是借款人）。 */
  role: z.enum(['borrow', 'lend']),
  counterpartyId: z.number().int().positive(),
  principal: z.number().int().positive(),
  /** 应还总额（本金 + 利息）。等于 principal 即零息。 */
  repayAmount: z.number().int().positive(),
  termDays: z.number().int().positive(),
  note: z.string().max(120).optional(),
});
export const P2pRepaySchema = z.object({ amount: z.number().int().positive() });

// —— work ——
export const ShiftSchema = z.object({ jobId: z.number().int().positive() });
export const EnrollSchema = z.object({ ability: z.enum(['EDU', 'CODE', 'FIN', 'FIT', 'COMM', 'DESIGN']) });

// —— 推断类型 ——
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type PlaceOrderInput = z.infer<typeof PlaceOrderSchema>;
export type BorrowInput = z.infer<typeof BorrowSchema>;
export type RepayInput = z.infer<typeof RepaySchema>;
export type P2pProposeInput = z.infer<typeof P2pProposeSchema>;
export type P2pRepayInput = z.infer<typeof P2pRepaySchema>;
export type ShiftInput = z.infer<typeof ShiftSchema>;
export type EnrollInput = z.infer<typeof EnrollSchema>;
