import React, { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Bell, Package, ShoppingCart, AlertTriangle, BarChart3, Truck, Megaphone, Store, ChevronRight, TrendingUp, Clock3, CircleDollarSign, CheckCircle2, Settings } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const productsSeed = [
  {
    id: "SKU-001",
    name: "NEOBEAUTE 薬用リンクルケアアイシート",
    stock: 124,
    price: "¥3,280",
    sales: 312,
    status: "active",
    approval: "approved",
  },
  {
    id: "SKU-002",
    name: "CICA モイスチャーローション",
    stock: 18,
    price: "¥2,480",
    sales: 190,
    status: "low_stock",
    approval: "approved",
  },
  {
    id: "SKU-003",
    name: "ビタミン美容液 30ml",
    stock: 0,
    price: "¥4,200",
    sales: 88,
    status: "out_of_stock",
    approval: "pending",
  },
  {
    id: "SKU-004",
    name: "クレンジングバーム",
    stock: 63,
    price: "¥2,980",
    sales: 141,
    status: "active",
    approval: "review",
  },
];

const ordersSeed = [
  { id: "O-240321", customer: "山田 花子", total: "¥6,560", shipping: "発送待ち", age: "12分前" },
  { id: "O-240320", customer: "株式会社 Lumiere", total: "¥12,400", shipping: "対応要", age: "27分前" },
  { id: "O-240319", customer: "佐藤 健", total: "¥3,280", shipping: "発送済み", age: "1時間前" },
  { id: "O-240318", customer: "高橋 美咲", total: "¥9,940", shipping: "発送待ち", age: "2時間前" },
];

const chartData = [
  { name: "月", sales: 22 },
  { name: "火", sales: 28 },
  { name: "水", sales: 19 },
  { name: "木", sales: 33 },
  { name: "金", sales: 41 },
  { name: "土", sales: 36 },
  { name: "日", sales: 24 },
];

function statusBadge(status) {
  switch (status) {
    case "active":
      return <Badge className="rounded-full">販売中</Badge>;
    case "low_stock":
      return <Badge variant="secondary" className="rounded-full">在庫少</Badge>;
    case "out_of_stock":
      return <Badge variant="destructive" className="rounded-full">在庫切れ</Badge>;
    default:
      return <Badge className="rounded-full">確認中</Badge>;
  }
}

function approvalBadge(status) {
  switch (status) {
    case "approved":
      return <Badge className="rounded-full">承認済み</Badge>;
    case "pending":
      return <Badge variant="secondary" className="rounded-full">申請中</Badge>;
    case "review":
      return <Badge variant="outline" className="rounded-full">要確認</Badge>;
    default:
      return <Badge variant="outline" className="rounded-full">未設定</Badge>;
  }
}

const summaryCards = [
  { title: "本日の売上", value: "¥128,400", sub: "+12.4%", icon: CircleDollarSign },
  { title: "未発送注文", value: "18", sub: "要対応 4件", icon: Truck },
  { title: "公開中商品", value: "146", sub: "申請中 7件", icon: Package },
  { title: "広告経由売上", value: "¥32,800", sub: "ROAS 4.3", icon: Megaphone },
];

export default function AmazonLikeSellerDashboard() {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("overview");
  const [filter, setFilter] = useState("all");

  const filteredProducts = useMemo(() => {
    return productsSeed.filter((item) => {
      const matchesQuery = item.name.toLowerCase().includes(query.toLowerCase()) || item.id.toLowerCase().includes(query.toLowerCase());
      const matchesFilter = filter === "all" ? true : item.status === filter;
      return matchesQuery && matchesFilter;
    });
  }, [query, filter]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <Store className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">店舗管理</p>
              <h1 className="text-xl font-semibold">Oja Immanuel Bacchus Seller Center</h1>
            </div>
          </div>

          <div className="ml-auto flex w-full max-w-xl items-center gap-3 rounded-2xl border bg-slate-50 px-4 py-2">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="商品名・SKUで検索"
              className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
            />
          </div>

          <Button variant="outline" className="rounded-2xl">
            <Bell className="mr-2 h-4 w-4" /> 通知
          </Button>
          <Button className="rounded-2xl">商品を追加</Button>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-6 px-6 py-6">
        <aside className="col-span-12 lg:col-span-3 xl:col-span-2">
          <Card className="rounded-3xl shadow-sm">
            <CardContent className="p-4">
              <div className="space-y-2">
                {[
                  ["overview", "ダッシュボード", BarChart3],
                  ["orders", "注文管理", ShoppingCart],
                  ["products", "商品管理", Package],
                  ["inventory", "在庫", Truck],
                  ["ads", "広告", Megaphone],
                  ["settings", "設定", Settings],
                ].map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm transition ${tab === key ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </aside>

        <main className="col-span-12 lg:col-span-9 xl:col-span-10 space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map((card) => {
              const Icon = card.icon;
              return (
                <Card key={card.title} className="rounded-3xl shadow-sm">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm text-slate-500">{card.title}</p>
                        <p className="mt-2 text-3xl font-semibold tracking-tight">{card.value}</p>
                        <p className="mt-2 text-sm text-slate-500">{card.sub}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-100 p-3">
                        <Icon className="h-5 w-5" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <Card className="rounded-3xl shadow-sm xl:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div>
                  <CardTitle className="text-lg">売上推移</CardTitle>
                  <p className="mt-1 text-sm text-slate-500">過去7日間の注文売上</p>
                </div>
                <Tabs value="7d">
                  <TabsList className="rounded-2xl">
                    <TabsTrigger value="7d">7日</TabsTrigger>
                    <TabsTrigger value="30d">30日</TabsTrigger>
                    <TabsTrigger value="90d">90日</TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>
              <CardContent className="h-[320px] pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="sales" radius={[10, 10, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="rounded-3xl shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">アカウント健全性</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span>注文不良率</span>
                    <span>0.4%</span>
                  </div>
                  <Progress value={18} className="h-2" />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span>出荷遅延率</span>
                    <span>1.2%</span>
                  </div>
                  <Progress value={28} className="h-2" />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span>キャンセル率</span>
                    <span>0.3%</span>
                  </div>
                  <Progress value={12} className="h-2" />
                </div>

                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm">
                  <div className="mb-2 flex items-center gap-2 font-medium text-amber-900">
                    <AlertTriangle className="h-4 w-4" />
                    要対応アラート
                  </div>
                  <p className="text-amber-800">在庫切れ商品が1件あります。機会損失を避けるため補充を検討してください。</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-5">
            <Card className="rounded-3xl shadow-sm xl:col-span-3">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-lg">注文の優先対応</CardTitle>
                  <p className="mt-1 text-sm text-slate-500">未発送・要確認の注文を上に表示</p>
                </div>
                <Button variant="ghost" className="rounded-2xl">すべて見る <ChevronRight className="ml-1 h-4 w-4" /></Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {ordersSeed.map((order) => (
                  <div key={order.id} className="flex items-center gap-4 rounded-2xl border p-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100">
                      <ShoppingCart className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{order.id}</p>
                        <Badge variant={order.shipping === "対応要" ? "destructive" : order.shipping === "発送待ち" ? "secondary" : "outline"} className="rounded-full">
                          {order.shipping}
                        </Badge>
                      </div>
                      <p className="truncate text-sm text-slate-500">{order.customer} ・ {order.total}</p>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                      <Clock3 className="h-4 w-4" /> {order.age}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="rounded-3xl shadow-sm xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-lg">すぐ使う操作</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {[
                  ["商品申請を確認", CheckCircle2],
                  ["在庫切れ商品を確認", Package],
                  ["広告キャンペーンを見る", TrendingUp],
                  ["配送テンプレートを編集", Truck],
                ].map(([label, Icon]) => (
                  <button key={label} className="flex items-center justify-between rounded-2xl border px-4 py-4 text-left hover:bg-slate-50">
                    <div className="flex items-center gap-3">
                      <div className="rounded-2xl bg-slate-100 p-2"><Icon className="h-4 w-4" /></div>
                      <span className="text-sm font-medium">{label}</span>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </button>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card className="rounded-3xl shadow-sm">
            <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="text-lg">商品管理</CardTitle>
                <p className="mt-1 text-sm text-slate-500">Amazonっぽく一覧性を重視しつつ、申請状況も同じ画面で確認</p>
              </div>
              <div className="flex gap-3">
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="商品を検索" className="w-[220px] rounded-2xl" />
                <Select value={filter} onValueChange={setFilter}>
                  <SelectTrigger className="w-[180px] rounded-2xl">
                    <SelectValue placeholder="状態で絞り込み" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">すべて</SelectItem>
                    <SelectItem value="active">販売中</SelectItem>
                    <SelectItem value="low_stock">在庫少</SelectItem>
                    <SelectItem value="out_of_stock">在庫切れ</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-separate border-spacing-y-2 text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="px-4 py-2 font-medium">商品</th>
                      <th className="px-4 py-2 font-medium">SKU</th>
                      <th className="px-4 py-2 font-medium">在庫</th>
                      <th className="px-4 py-2 font-medium">価格</th>
                      <th className="px-4 py-2 font-medium">販売数</th>
                      <th className="px-4 py-2 font-medium">状態</th>
                      <th className="px-4 py-2 font-medium">申請</th>
                      <th className="px-4 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProducts.map((item) => (
                      <tr key={item.id} className="rounded-2xl bg-slate-50">
                        <td className="rounded-l-2xl px-4 py-4 font-medium">{item.name}</td>
                        <td className="px-4 py-4 text-slate-600">{item.id}</td>
                        <td className="px-4 py-4">{item.stock}</td>
                        <td className="px-4 py-4">{item.price}</td>
                        <td className="px-4 py-4">{item.sales}</td>
                        <td className="px-4 py-4">{statusBadge(item.status)}</td>
                        <td className="px-4 py-4">{approvalBadge(item.approval)}</td>
                        <td className="rounded-r-2xl px-4 py-4 text-right">
                          <Button variant="outline" className="rounded-2xl">詳細</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}
