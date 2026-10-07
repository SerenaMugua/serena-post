// 标题自带序号时不重复编号
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCnNumber, stripHeadingNumber } from '../src/utils/formatter';

test('中文数字转数字', () => {
	assert.equal(parseCnNumber('一'), 1);
	assert.equal(parseCnNumber('十'), 10);
	assert.equal(parseCnNumber('十二'), 12);
	assert.equal(parseCnNumber('二十'), 20);
	assert.equal(parseCnNumber('九十九'), 99);
	assert.equal(parseCnNumber('7'), 7);
	assert.equal(parseCnNumber('abc'), null);
});

function strip(text: string) {
	const h = document.createElement('h2');
	h.textContent = text;
	return { n: stripHeadingNumber(h), rest: h.textContent };
}

test('各种写法的序号都能识别并去掉', () => {
	assert.deepEqual(strip('一、为什么'), { n: 1, rest: '为什么' });
	assert.deepEqual(strip('（三）原因'), { n: 3, rest: '原因' });
	assert.deepEqual(strip('第二章 开始'), { n: 2, rest: '开始' });
	assert.deepEqual(strip('4. 总结'), { n: 4, rest: '总结' });
	assert.deepEqual(strip('05 收尾'), { n: 5, rest: '收尾' });
});

test('「5 个技巧」这类不是序号，不动', () => {
	assert.deepEqual(strip('5 个技巧'), { n: null, rest: '5 个技巧' });
	assert.deepEqual(strip('普通标题'), { n: null, rest: '普通标题' });
});

test('标题只有序号本身时不动', () => {
	assert.deepEqual(strip('一、'), { n: null, rest: '一、' });
});
