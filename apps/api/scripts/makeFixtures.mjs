// Generates realistic fixture uploads for an end-to-end API check.
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const out = process.argv[2];
await fs.mkdir(out, { recursive: true });

const PR_CSV = [
  'Toit Payment Report,,,,,,,,,,,',
  'Order No,Date,Customer Name,Employee,Payment Type,Payment Name,Card Number,Auth Code,Amount,Tip,Bank,Retrieval Reference No',
  '1001,01-Aug-2026 21:14:03,Alice,E1,Card,Pinelabs APOS,411111,A1,1000.00,0,HDFC,100000000001',
  '1002,01-Aug-2026 21:20:00,Bob,E1,Card,Pinelabs APOS,411111,A2,600.00,0,HDFC,100000000002',
  '1003,01-Aug-2026 21:21:00,Bob,E1,Card,Pinelabs APOS,411111,A3,400.00,0,HDFC,100000000002',
  '1004,01-Aug-2026 21:30:00,Carol,E2,Card,Pinelabs APOS,411111,A4,500.00,0,HDFC,100000000003',
  '1005,01-Aug-2026 21:40:00,Dan,E2,Card,Manual APOS,,A5,300.00,0,HDFC,100000000004',
  '1006,01-Aug-2026 21:50:00,Eve,E3,Card,Pinelabs APOS,411111,A6,700.00,0,HDFC,100000000005',
  '1007,01-Aug-2026 22:00:00,Fay,E3,Card,Pinelabs APOS,411111,A7,900.00,0,HDFC,100000000007',
  '1008,01-Aug-2026 22:05:00,Gil,E3,Card,Pinelabs APOS,411111,A8,250.00,0,HDFC,',
  '1009,01-Aug-2026 22:10:00,Hal,E4,Card,Pinelabs APOS,371111,AUTH01,1500.00,0,AMEX,200000000001',
  '1010,01-Aug-2026 22:15:00,Ivy,E4,Card,Pinelabs APOS,371111,,1600.00,0,American Express,200000000002',
  '1011,01-Aug-2026 22:20:00,Jon,E4,Card,Pinelabs APOS,371111,AUTH03,1700.00,0,AMEX,200000000003',
  '1012,01-Aug-2026 22:25:00,Kim,E5,Cash,Cash,,,450.00,0,,',
  '1013,01-Aug-2026 22:30:00,Lea,E5,UPI,HDFC Static UPI,,,350.00,0,,300000000001',
  '1014,01-Aug-2026 22:35:00,Moe,E5,Hold,Bills on Hold,,,275.00,0,,',
  '1015,01-Aug-2026 22:40:00,Ned,E5,Bank,Bank transfer,,,525.00,0,,',
  '1016,01-Aug-2026 22:45:00,Oli,E5,Online,Swiggy,,,199.00,0,,',
].join('\n');

const ZIP_HEADER =
  'Acquirer,Payment Mode,Name,Card Issuer,Amount,Tip Amount,Date,Batch Status,' +
  'Txn Status,RRN,Settlement Date,Bill Invoice,Invoice,Approval Code,Type,Zone,' +
  'Store Name,TID,MID,Hardware Model';

const ZIP_CSV = [
  ZIP_HEADER,
  'PINELABS,CARD,Alice,VISA,1000.00,0,01/08/2026 09:14:03 PM,Settled,Success,100000000001,02/08/2026,B1,INV1,A1,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Bob,VISA,1000.00,0,01/08/2026 09:20:30 PM,Settled,Success,100000000002,02/08/2026,B2,INV2,A2,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Carol,VISA,520.00,0,01/08/2026 09:30:00 PM,Settled,Success,100000000003,02/08/2026,B3,INV3,A3,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Dan,VISA,300.00,0,01/08/2026 09:40:00 PM,Settled,Success,100000000004,02/08/2026,B4,INV4,A4,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Zed,VISA,800.00,0,01/08/2026 09:45:00 PM,Settled,Success,100000000006,02/08/2026,B5,INV5,A5,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Fay,VISA,900.00,0,01/08/2026 10:00:00 PM,Settled,Success,100000000007,02/08/2026,B6,INV6,A6,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Fay,VISA,900.00,0,01/08/2026 10:00:05 PM,Settled,Success,100000000007,02/08/2026,B7,INV7,A7,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'AMEX,CARD,Hal,AMEX,1500.00,0,01/08/2026 10:10:00 PM,Settled,Success,,02/08/2026,B8,INV8,AUTH01,Sale,South,Toit- Bangalore,T1,M2,APOS',
  'AMEX,CARD,Ivy,AMEX,1600.00,0,01/08/2026 10:15:00 PM,Settled,Success,,02/08/2026,B9,INV9,,Sale,South,Toit- Bangalore,T1,M2,APOS',
  'PINELABS,CARD,Late,VISA,111.00,0,02/08/2026 09:00:00 AM,Settled,Success,100000000099,02/08/2026,B10,INV10,A10,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,CARD,Fail,VISA,222.00,0,01/08/2026 10:20:00 PM,Pending,FAILED,100000000098,02/08/2026,B11,INV11,A11,Sale,South,Toit- Bangalore,T1,M1,APOS',
  'PINELABS,PAPER POS,Paper,VISA,333.00,0,01/08/2026 10:25:00 PM,Settled,Success,100000000097,02/08/2026,B12,INV12,A12,Sale,South,Toit- Bangalore,T1,M1,PAPER POS',
].join('\n');

const SUMMARY_CSV = [
  'Business Date,Cash,Pinelabs APOS,HDFC Static UPI,Kotak Static UPI,Bills on Hold,Bank transfer',
  '01-Aug-2026,"450.00","5,020.00","350.00","0.00","275.00","525.00"',
].join('\n');

await fs.writeFile(path.join(out, 'PaymentReport_01Aug2026.csv'), PR_CSV, 'utf8');
await fs.writeFile(path.join(out, 'payment_summary_01Aug2026.csv'), SUMMARY_CSV, 'utf8');

const z = new JSZip();
z.file('AllTransactions.csv', ZIP_CSV);
await fs.writeFile(
  path.join(out, 'AllTransactions_01Aug2026.zip'),
  await z.generateAsync({ type: 'nodebuffer' }),
);

const aoa = [
  ['Transaction Date', 'Transaction Time', 'City', 'Transaction State', 'Amount(Rs.)', 'RRN No', "Payer's name"],
  ['2026-08-01', '10:30:00 PM', 'BANGALORE', 'SaleSuccess', 350, '300000000001', 'Lea'],
  ['2026-08-01', '10:36:00 PM', 'BANGALORE', 'SaleFailed', 100, '300000000002', 'Nope'],
  ['2026-08-01', '10:37:00 PM', 'DELHI', 'SaleSuccess', 200, '300000000003', 'Far'],
  ['2026-08-01', '10:38:00 PM', 'BANGALORE', 'SaleSuccess', 275, '300000000004', 'Xtra'],
];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Statement');
await fs.writeFile(
  path.join(out, 'hdfc_upi_statement.xlsx'),
  XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
);

console.log('fixtures written to ' + out);
