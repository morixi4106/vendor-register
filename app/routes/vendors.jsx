export default function Vendors() {
  return (
    <div style={{maxWidth:"1200px",margin:"0 auto",padding:"40px"}}>
      <h1 style={{fontSize:"42px",fontWeight:"800",marginBottom:"40px"}}>
        店舗一覧
      </h1>

      <div style={{
        display:"grid",
        gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",
        gap:"24px"
      }}>
        <a href="/vendors/sample-store" style={{
          border:"1px solid #ddd",
          padding:"20px",
          borderRadius:"12px",
          textDecoration:"none",
          color:"#111"
        }}>
          Sample Store
        </a>
      </div>
    </div>
  );
}