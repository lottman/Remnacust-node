#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
image=${1:-remnacust-node:1.1.1}
test_root=$(mktemp -d)
test_name="remnacust-node-smoke-$$-$(date +%s)"
cleanup() {
 status=$?
 if [ "$status" != 0 ]; then docker logs --tail 70 "$test_name" 2>&1 || true; fi
 docker rm -f "$test_name" >/dev/null 2>&1 || true
 rm -f "$test_root"/{ca.key,ca.crt,ca.srl,node.key,node.csr,node.crt,node.ext,jwt.key,jwt.pub,node.env,check.cjs,result.txt}
 rmdir "$test_root" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$test_root/ca.key" -out "$test_root/ca.crt" -subj /CN=Remnacust-release-test-CA -days 1 >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$test_root/node.key" -out "$test_root/node.csr" -subj /CN=localhost >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\n' > "$test_root/node.ext"
openssl x509 -req -in "$test_root/node.csr" -CA "$test_root/ca.crt" -CAkey "$test_root/ca.key" -CAcreateserial -out "$test_root/node.crt" -days 1 -extfile "$test_root/node.ext" >/dev/null 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$test_root/jwt.key" >/dev/null 2>&1
openssl pkey -in "$test_root/jwt.key" -pubout -out "$test_root/jwt.pub" >/dev/null 2>&1
python3 - "$test_root" <<'PY'
import base64,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
payload={name:(root/file).read_text() for name,file in {'caCertPem':'ca.crt','jwtPublicKey':'jwt.pub','nodeCertPem':'node.crt','nodeKeyPem':'node.key'}.items()}
(root/'node.env').write_text('NODE_PORT=2222\nSNI_VERIFICATION=false\nSECRET_KEY='+base64.b64encode(json.dumps(payload).encode()).decode()+'\n')
PY
cat > "$test_root/check.cjs" <<'JS'
const fs=require('node:fs'), https=require('node:https'), crypto=require('node:crypto');
const read=name=>fs.readFileSync('/test/'+name);
const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
const body=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+120,sub:'release-smoke'})).toString('base64url');
const signature=crypto.sign('RSA-SHA256',Buffer.from(header+'.'+body),read('jwt.key')).toString('base64url');
const token=header+'.'+body+'.'+signature;
function request(authorized, certificate=true){return new Promise((resolve,reject)=>{
 const r=https.request({host:'127.0.0.1',port:2222,path:'/node/xray/healthcheck',ca:read('ca.crt'),
  ...(certificate?{cert:read('node.crt'),key:read('node.key')}:{}),
  headers:authorized?{Authorization:'Bearer '+token}:{},timeout:8000},res=>{
  let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:text}));
 });r.on('error',reject);r.on('timeout',()=>r.destroy(Error('timeout')));r.end();
});}
(async()=>{
 const ready=await request(true);
 if(ready.status!==200)throw Error('health status '+ready.status);
 const data=JSON.parse(ready.body).response;
 if(data.isAlive!==true||data.nodeVersion!=='1.1.1-remnacust'||data.xrayVersion!=='1.1.1')throw Error('wrong health response '+JSON.stringify(data));
 if((await request(false)).status!==401)throw Error('JWT authentication is not enforced');
 let rejected=false;try{await request(true,false)}catch{rejected=true}
 if(!rejected)throw Error('mTLS is not enforced');
 console.log('PASS: complete node startup, version 1.1.1, authenticated health API, JWT rejection and mTLS rejection');
})().catch(e=>{console.error(e.message);process.exitCode=1});
JS
docker run -d --name "$test_name" --cap-add NET_ADMIN --env-file "$test_root/node.env" -v "$test_root:/test:ro" "$image" >/dev/null
ready=0
for attempt in $(seq 1 35); do
 if docker exec "$test_name" node /test/check.cjs > "$test_root/result.txt" 2>&1; then ready=1; break; fi
 sleep 2
done
cat "$test_root/result.txt"
rm -f "$test_root/result.txt"
test "$ready" = 1
test "$(docker inspect -f '{{.State.Running}}' "$test_name")" = true
