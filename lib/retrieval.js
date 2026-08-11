import crypto from "node:crypto";
import path from "node:path";

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9_./-]+|[\u4e00-\u9fa5]+/g) || [])
    .filter((term) => term.length > 1 && !["the", "and", "for", "with", "from", "this", "that"].includes(term));
}

function expandQueryTerms(query) {
  const terms = tokenize(query);
  const lower = query.toLowerCase();
  const expansions = [
    [["auth", "login", "user", "jwt", "password", "认证", "登录", "用户"], ["auth", "login", "user", "jwt", "password"]],
    [["order", "checkout", "createorder", "orderstatus", "订单", "下单", "结账"], ["order", "checkout", "createorder", "orderstatus"]],
    [["payment", "charge", "paid", "gateway", "支付", "扣款"], ["payment", "charge", "paid", "gateway"]],
    [["refund", "refunded", "refundservice", "退款", "退货"], ["refund", "refunded", "refundservice"]],
    [["coupon", "discount", "validatecoupon", "优惠券", "折扣"], ["coupon", "discount", "validatecoupon"]],
    [["status", "type", "model", "schema", "状态", "字段", "模型"], ["status", "type", "model", "schema"]],
    [["test", "spec", "scenario", "failure", "测试", "用例", "失败"], ["test", "spec", "scenario", "failure"]],
    [["readme", "onboarding", "first", "module", "新人", "入门", "模块"], ["readme", "onboarding", "first", "read", "module"]],
    [["api", "route", "controller", "endpoint", "接口", "路由"], ["api", "route", "controller", "endpoint"]],
    [["impact", "change", "service", "model", "test", "影响", "变更"], ["impact", "change", "service", "model", "test"]]
  ];
  expansions.forEach(([needles, words]) => {
    if (needles.some((needle) => lower.includes(needle))) terms.push(...words);
  });
  return [...new Set(terms)];
}

function chunkFile(file) {
  const lines = file.content.split(/\r?\n/);
  const chunks = [];
  let current = [];
  let startLine = 1;
  let charCount = 0;

  lines.forEach((line, index) => {
    current.push(line);
    charCount += line.length + 1;
    const shouldFlush = current.length >= 70 || charCount > 3500 || index === lines.length - 1;
    if (shouldFlush) {
      const content = current.join("\n").trim();
      if (content) {
        chunks.push({
          id: crypto.randomUUID(),
          file_path: file.path,
          file_type: path.extname(file.path).slice(1) || "txt",
          chunk_index: chunks.length,
          start_line: startLine,
          end_line: index + 1,
          content,
          terms: tokenize(`${file.path}\n${content}`)
        });
      }
      current = [];
      startLine = index + 2;
      charCount = 0;
    }
  });

  return chunks;
}

function retrieveChunks(project, query, topK = 8) {
  const queryTerms = expandQueryTerms(query);
  const querySet = new Set(queryTerms);
  const phrase = query.toLowerCase();

  return project.chunks
    .map((chunk) => {
      const termCounts = new Map();
      chunk.terms.forEach((term) => termCounts.set(term, (termCounts.get(term) || 0) + 1));
      let score = 0;
      querySet.forEach((term) => {
        const count = termCounts.get(term) || 0;
        if (count) score += Math.min(count, 6) * (chunk.file_path.toLowerCase().includes(term) ? 3 : 1);
      });
      if (phrase && chunk.content.toLowerCase().includes(phrase)) score += 20;
      if (queryTerms.some((term) => chunk.file_path.toLowerCase().includes(term))) score += 8;
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export { tokenize, expandQueryTerms, chunkFile, retrieveChunks };
