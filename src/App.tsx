import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import {
  Upload, FileText, BarChart3, PieChart as PieChartIcon,
  CheckCircle2, AlertCircle, LayoutDashboard, Download,
  FileSpreadsheet, MousePointerSquareDashed, XCircle, ShieldCheck,
  ChevronDown, ChevronUp, ArrowUpRight, Scale, BrainCircuit, Filter,
  MinusCircle, PlusCircle, Info
} from 'lucide-react';

// --- Types & Interfaces ---

interface RawDataRow {
  text?: string;
  actual_intent?: string;
  predicted_intent?: string;
  actual_entities?: any;
  predicted_entities?: any;
  oos_flag?: string | number;
  [key: string]: any; // For other dynamic columns
}

interface IntentMetric {
  intent: string;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  recall: number;
  precision: number;
  f1: number;
}

interface MetricsResult {
  intents: IntentMetric[];
  entityAcc: number;
  avgF1: number;
  avgRecall: number;
  avgPrecision: number;
  incorrectEntities: number;
}

interface AnalysisResult {
  inS: RawDataRow[];
  outS: RawDataRow[];
  inM: MetricsResult;
  outM: MetricsResult;
  isSampleCountOk: boolean;
  isModelPassed: boolean;
}

interface EntityComparison {
  match: boolean;
  tp: number;
  fp: number;
  fn: number;
  missing: string[];
  extra: string[];
}

interface SortConfig {
  key: keyof RawDataRow | null;
  direction: 'asc' | 'desc';
}

declare global {
  interface Window {
    XLSX: any;
  }
}

// --- Utility for Shadcn-like styling ---
const cn = (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' ');

const App: React.FC = () => {
  const [rawData, setRawData] = useState<RawDataRow[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: null, direction: 'asc' });
  const [filterType, setFilterType] = useState<string>('all'); // all, intent_mismatch, entity_mismatch
  const [showSourceCode, setShowSourceCode] = useState<boolean>(false);

  // Constants
  const PASS_THRESHOLD = 0.95;
  const ACCEPT_THRESHOLD = 0.85;

  useEffect(() => {
    const script = document.createElement('script');
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.async = true;
    document.body.appendChild(script);
  }, []);

  // --- Entity Comparison Logic ---
  const compareEntities = useCallback((actualStr: any, predictedStr: any): EntityComparison => {
    try {
      const parse = (val: any) => {
        if (typeof val === 'string') {
          try { return JSON.parse(val || '[]'); } catch { return []; }
        }
        return Array.isArray(val) ? val : [];
      };

      const actual = parse(actualStr);
      const predicted = parse(predictedStr);

      const actualNames: string[] = actual.map((e: any) => e.entity || e);
      const predictedNames: string[] = predicted.map((e: any) => e.entity || e);

      const missing = actualNames.filter(n => !predictedNames.includes(n));
      const extra = predictedNames.filter(n => !actualNames.includes(n));

      const isMatch = actualNames.length === predictedNames.length && missing.length === 0 && extra.length === 0;

      return {
        match: isMatch,
        tp: actualNames.length - missing.length,
        fp: extra.length,
        fn: missing.length,
        missing,
        extra
      };
    } catch (e) {
      return { match: true, tp: 0, fp: 0, fn: 0, missing: [], extra: [] };
    }
  }, []);

  // --- File Processing with Header Normalization ---
  const processFile = (file: File) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

    reader.onload = (e: ProgressEvent<FileReader>) => {
      try {
        let data: any[] = [];
        if (isExcel && e.target?.result) {
          const workbook = window.XLSX.read(e.target.result, { type: 'binary' });
          data = window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        } else if (e.target?.result) {
          const text = e.target.result as string;
          const rows = text.split(/\r?\n/).filter(row => row.trim() !== '');
          const headers = rows[0].split(',').map(h => h.trim().replace(/"/g, ''));
          data = rows.slice(1).map(row => {
            const values = row.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
            const obj: any = {};
            headers.forEach((header, i) => {
              obj[header] = values[i] ? values[i].replace(/"/g, '') : '';
            });
            return obj;
          });
        }

        // --- Critical: Normalize Keys for Internal Engine ---
        const normalizedData: RawDataRow[] = data.map(row => {
          const newRow: RawDataRow = { ...row };
          Object.keys(row).forEach(key => {
            const normKey = key.toLowerCase().trim().replace(/\s+/g, '_');

            if (normKey === 'actual_entity' || normKey === 'actual_entities') newRow.actual_entities = row[key];
            if (normKey === 'predicted_entity' || normKey === 'predicted_entities') newRow.predicted_entities = row[key];
            if (normKey === 'actual_intent') newRow.actual_intent = row[key];
            if (normKey === 'predicted_intent') newRow.predicted_intent = row[key];
            if (normKey === 'oos_flag') newRow.oos_flag = row[key];
          });
          return newRow;
        });

        setRawData(normalizedData);
        setActiveTab('dashboard');
      } catch (err) { console.error(err); }
    };
    if (isExcel) reader.readAsBinaryString(file);
    else reader.readAsText(file);
  };

  // --- Metrics Engine ---
  const getMetrics = useCallback((data: RawDataRow[]): MetricsResult => {
    if (!data.length) return { intents: [], entityAcc: 0, avgF1: 0, avgRecall: 0, avgPrecision: 0, incorrectEntities: 0 };

    const intentList = Array.from(new Set(data.map(item => item.actual_intent).filter(Boolean))) as string[];
    let totalEntityCorrect = 0;
    let incorrectEntitiesCount = 0;

    const intentMetrics = intentList.map(intent => {
      let tp = 0, fn = 0, fp = 0, tn = 0;
      data.forEach(item => {
        const actual = item.actual_intent;
        const predicted = item.predicted_intent;
        if (actual === intent && predicted === intent) tp++;
        else if (actual === intent && predicted !== intent) fn++;
        else if (actual !== intent && predicted === intent) fp++;
        else if (actual !== intent && predicted !== intent) tn++;
      });

      const recall = tp / (tp + fn) || 0;
      const precision = tp / (tp + fp) || 0;
      const f1 = (2 * precision * recall) / (precision + recall) || 0;
      return { intent, tp, fn, fp, tn, recall, precision, f1 };
    });

    data.forEach(item => {
      const res = compareEntities(item.actual_entities, item.predicted_entities);
      if (res.match) {
        totalEntityCorrect++;
      } else {
        incorrectEntitiesCount++;
      }
    });

    const avgF1 = intentMetrics.reduce((a, b) => a + b.f1, 0) / intentMetrics.length || 0;
    const avgRecall = intentMetrics.reduce((a, b) => a + b.recall, 0) / intentMetrics.length || 0;
    const avgPrecision = intentMetrics.reduce((a, b) => a + b.precision, 0) / intentMetrics.length || 0;
    const entityAcc = totalEntityCorrect / data.length || 0;

    return {
      intents: intentMetrics,
      entityAcc,
      avgF1,
      avgRecall,
      avgPrecision,
      incorrectEntities: incorrectEntitiesCount
    };
  }, [compareEntities]);

  const analysis = useMemo<AnalysisResult>(() => {
    const inS = rawData.filter(d => String(d.oos_flag) === '0' || !d.oos_flag || d.oos_flag === 'In Sample');
    const outS = rawData.filter(d => String(d.oos_flag) === '1' || d.oos_flag === 'Out Sample');
    const inM = getMetrics(inS);
    const outM = getMetrics(outS);

    const isSampleCountOk = outS.length >= inS.length;
    const isModelPassed = inM.avgF1 >= ACCEPT_THRESHOLD && outM.avgF1 >= ACCEPT_THRESHOLD && inM.entityAcc >= ACCEPT_THRESHOLD;

    return { inS, outS, inM, outM, isSampleCountOk, isModelPassed };
  }, [rawData, getMetrics]);

  // --- Filtered & Sorted Trace Data ---
  const traceData = useMemo(() => {
    let filtered = rawData.filter(d => {
      const entRes = compareEntities(d.actual_entities, d.predicted_entities);
      const intentMismatch = d.actual_intent !== d.predicted_intent;
      const entityMismatch = !entRes.match;

      if (filterType === 'intent_mismatch') return intentMismatch;
      if (filterType === 'entity_mismatch') return entityMismatch;
      return true;
    });

    if (sortConfig.key) {
      filtered.sort((a, b) => {
        const aVal = a[sortConfig.key!];
        const bVal = b[sortConfig.key!];
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return filtered;
  }, [rawData, filterType, sortConfig, compareEntities]);

  const toggleSort = (key: keyof RawDataRow) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  // --- Export Function ---
  const handleExport = () => {
    if (!window.XLSX || !rawData.length) return;
    const wb = window.XLSX.utils.book_new();

    const knobsReport = [
      ["OMR AUDIT REPORT - DASHBOARD SUMMARY"],
      ["Generated", new Date().toLocaleString()],
      [],
      ["METRIC", "VALUE", "THRESHOLD", "STATUS"],
      ["Model Overall Acceptance", analysis.isModelPassed ? "PASS" : "FAIL", "85%+", analysis.isModelPassed ? "OK" : "REJECTED"],
      ["In-Sample F1 Score", analysis.inM.avgF1.toFixed(4), "85%", analysis.inM.avgF1 >= 0.85 ? "PASS" : "FAIL"],
      ["Out-Sample F1 Score", analysis.outM.avgF1.toFixed(4), "85%", analysis.outM.avgF1 >= 0.85 ? "PASS" : "FAIL"],
      ["In-Sample Entity Accuracy", analysis.inM.entityAcc.toFixed(4), "85%", analysis.inM.entityAcc >= 0.85 ? "PASS" : "FAIL"],
      ["Sample Coverage Check", `${analysis.outS.length} vs ${analysis.inS.length}`, "Out >= In", analysis.isSampleCountOk ? "PASS" : "FAIL"]
    ];
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(knobsReport), "Audit Report");

    const intents = Array.from(new Set(rawData.map(d => d.actual_intent).filter(Boolean))) as string[];
    const summaryCountData = [["Row Labels", "In-Sample (0)", "Out-Sample (1)", "Grand Total"]];
    intents.forEach(intent => {
      const inCount = rawData.filter(d => d.actual_intent === intent && (String(d.oos_flag) === '0' || !d.oos_flag)).length;
      const outCount = rawData.filter(d => d.actual_intent === intent && String(d.oos_flag) === '1').length;
      //@ts-ignore
      summaryCountData.push([intent, inCount, outCount, inCount + outCount]);
    });
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(summaryCountData), "Summary Count");

    const createSummarySheet = (metrics: MetricsResult) => {
      const aoa = [
        ["Intent Name", "TP", "FN", "FP", "TN", "Recall", "Precision", "F1 Score"],
        ...metrics.intents.map(m => [m.intent, m.tp, m.fn, m.fp, m.tn, m.recall, m.precision, m.f1])
      ];
      return window.XLSX.utils.aoa_to_sheet(aoa);
    };
    window.XLSX.utils.book_append_sheet(wb, createSummarySheet(analysis.inM), "In Sample Summary");
    window.XLSX.utils.book_append_sheet(wb, createSummarySheet(analysis.outM), "Out Sample Summary");
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(rawData), "Raw Trace");

    window.XLSX.writeFile(wb, `Rasa_OMR_Full_Audit_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  // --- Sub-Components ---
  interface StatCardProps {
    title: string;
    value: string | number;
    subtext: string;
    status?: boolean;
    //@ts-ignore
    icon: LucideIcon;
  }

  const StatCard: React.FC<StatCardProps> = ({ title, value, subtext, status, icon: Icon }) => (
    <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm hover:shadow-md transition-all group">
      <div className="flex justify-between items-start mb-4">
        <div className="p-2 bg-slate-50 rounded-lg group-hover:bg-slate-900 group-hover:text-white transition-colors">
          <Icon size={18} />
        </div>
        {status !== undefined && (
          <span className={cn(
            "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider",
            status ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
          )}>
            {status ? "Passed" : "Action Needed"}
          </span>
        )}
      </div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-tight mb-1">{title}</p>
      <h3 className="text-2xl font-bold text-slate-900">{typeof value === 'number' ? value.toFixed(4) : value}</h3>
      <p className="text-[11px] text-slate-400 mt-1 font-medium">{subtext}</p>
    </div>
  );

  // Complete source code for display in modal
  const sourceCodeDisplay =  `import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import { 
  Upload, FileText, BarChart3, CheckCircle2, AlertCircle, LayoutDashboard, Download, 
  FileSpreadsheet, XCircle, ShieldCheck, ChevronDown, ChevronUp, ArrowUpRight, 
  Scale, BrainCircuit, MinusCircle, PlusCircle, Info, LucideIcon, Loader2
} from 'lucide-react';

// --- Constants ---
const PASS_THRESHOLD = 0.95;
const ACCEPT_THRESHOLD = 0.85;

// --- Types & Interfaces ---

interface RawDataRow {
  text?: string;
  actual_intent?: string;
  predicted_intent?: string;
  actual_entities?: any;
  predicted_entities?: any;
  oos_flag?: string | number;
  entity_crrct_flag?: string | number;
  intent_crrct_flag?: string | number;
  [key: string]: any; 
}

interface IntentMetric {
  intent: string;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  recall: number;
  precision: number;
  f1: number;
}

interface MetricsResult {
  intents: IntentMetric[];
  entityAcc: number; 
  avgF1: number;
  avgRecall: number;
  avgPrecision: number;
  incorrectEntities: number;
}

interface AnalysisResult {
  inS: RawDataRow[];
  outS: RawDataRow[];
  inM: MetricsResult;
  outM: MetricsResult;
  isSampleCountOk: boolean;
  isModelPassed: boolean;
}

interface EntityComparison {
  match: boolean;
  tp: number;
  fp: number;
  fn: number;
  missing: string[];
  extra: string[];
}

interface SortConfig {
  key: keyof RawDataRow | null;
  direction: 'asc' | 'desc';
}

declare global {
  interface Window {
    XLSX: any;
  }
}

// --- Utility Functions ---

const cn = (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' ');

const parseEntityVal = (val: any) => {
  if (val === undefined || val === null || val === '' || val === 'undefined' || val === '-') return [];
  
  if (typeof val === 'string') {
    const cleaned = val.trim();
    if (!cleaned || cleaned === '[]') return [];
    
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
      try { return JSON.parse(cleaned); } catch { /* ignore */ }
    }
    
    return cleaned.split(',').map(s => s.trim()).filter(Boolean);
  }
  
  return Array.isArray(val) ? val : [val];
};

const robustCSVSplit = (line: string): string[] => {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result.map(v => v.replace(/^"|"$/g, ''));
};

// --- Sub-Components ---

interface StatCardProps {
  title: string;
  value: string | number;
  subtext: string;
  status?: boolean;
  icon: LucideIcon;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, subtext, status, icon: Icon }) => (
  <div className="bg-white border border-slate-200 p-5 rounded-xl shadow-sm hover:shadow-md transition-all group">
    <div className="flex justify-between items-start mb-4">
      <div className="p-2 bg-slate-50 rounded-lg group-hover:bg-slate-900 group-hover:text-white transition-colors">
        <Icon size={18} />
      </div>
      {status !== undefined && (
        <span className={cn(
          "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider",
          status ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
        )}>
          {status ? "Passed" : "Action Needed"}
        </span>
      )}
    </div>
    <p className="text-xs font-semibold text-slate-500 uppercase tracking-tight mb-1">{title}</p>
    <h3 className="text-2xl font-bold text-slate-900">
      {typeof value === 'number' ? value.toFixed(4) : String(value)}
    </h3>
    <p className="text-[11px] text-slate-400 mt-1 font-medium">{subtext}</p>
  </div>
);

// --- Main App Component ---

const App: React.FC = () => {
  const [rawData, setRawData] = useState<RawDataRow[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: null, direction: 'asc' });
  const [filterType, setFilterType] = useState<string>('all');
  const [isLibReady, setIsLibReady] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Dynamic Library Loading & Monitoring
  useEffect(() => {
    // If library not present, inject it
    if (!window.XLSX) {
      const script = document.createElement('script');
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      script.onload = () => setIsLibReady(true);
      document.head.appendChild(script);
    } else {
      setIsLibReady(true);
    }

    const checkLib = setInterval(() => {
      if (window.XLSX) {
        setIsLibReady(true);
        clearInterval(checkLib);
      }
    }, 1000);
    return () => clearInterval(checkLib);
  }, []);

  const compareEntities = useCallback((actualStr: any, predictedStr: any): EntityComparison => {
    const actual = parseEntityVal(actualStr);
    const predicted = parseEntityVal(predictedStr);
    
    const actualNames: string[] = actual.map((e: any) => (e.entity || e || '').toString().toLowerCase().trim());
    const predictedNames: string[] = predicted.map((e: any) => (e.entity || e || '').toString().toLowerCase().trim());

    const missing = actualNames.filter(n => !predictedNames.includes(n));
    const extra = predictedNames.filter(n => !actualNames.includes(n));

    const isMatch = actualNames.length === predictedNames.length && 
                    missing.length === 0 && 
                    extra.length === 0;

    return {
      match: isMatch,
      tp: actualNames.length - missing.length,
      fp: extra.length,
      fn: missing.length,
      missing,
      extra
    };
  }, []);

  const isRowEntityCorrect = useCallback((row: RawDataRow): boolean => {
    if (row.entity_crrct_flag !== undefined && row.entity_crrct_flag !== null && row.entity_crrct_flag !== '') {
      const val = String(row.entity_crrct_flag).trim().toLowerCase();
      return ['1', 'true', 'pass', 'y', 'correct'].includes(val);
    }
    return compareEntities(row.actual_entities, row.predicted_entities).match;
  }, [compareEntities]);

  const processFile = (file: File) => {
    if (!file) return;
    setError(null);
    
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
    
    // Only block if it is an Excel file and library isn't ready
    if (isExcel && !isLibReady) {
      setError("Excel library still loading. Please try again in a few seconds.");
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();

    reader.onload = (e: ProgressEvent<FileReader>) => {
      try {
        let data: any[] = [];
        if (isExcel && e.target?.result) {
          const workbook = window.XLSX.read(e.target.result, { type: 'binary' });
          data = window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        } else if (e.target?.result) {
          const text = (e.target.result as string).replace(/^\uFEFF/, '');
          const lines = text.split(/\r\n|\n|\r/).filter(line => line.trim() !== '');
          if (lines.length < 2) {
            setError("The file appears to be empty or missing data rows.");
            return;
          }

          const headers = robustCSVSplit(lines[0]);
          data = lines.slice(1).map(line => {
            const values = robustCSVSplit(line);
            const obj: any = {};
            headers.forEach((header, i) => {
              obj[header] = values[i] !== undefined ? values[i] : '';
            });
            return obj;
          });
        }

        const normalizedData: RawDataRow[] = data.map(row => {
          const newRow: RawDataRow = { ...row };
          Object.keys(row).forEach(key => {
            const k = key.toLowerCase().trim().replace(/[\s_]+/g, '_');
            const val = row[key] ?? '';
            
            if (/actual_entit(ies|y)/.test(k)) newRow.actual_entities = val;
            if (/predicted_entit(ies|y)/.test(k)) newRow.predicted_entities = val;
            if (/actual_intent|intent_actual/.test(k)) newRow.actual_intent = val;
            if (/predicted_intent|intent_predicted/.test(k)) newRow.predicted_intent = val;
            if (/oos_flag|sample_type|is_out|sample_flag/.test(k)) newRow.oos_flag = val;
            if (/entity_crrct_flag|entity_correct|correct_entity|ent_flag|entity_status|crrct_flag/.test(k)) newRow.entity_crrct_flag = val;
            if (/text|utterance|query|input/.test(k)) newRow.text = val;
          });
          return newRow;
        });

        if (normalizedData.length > 0) {
          setRawData(normalizedData);
          setActiveTab('dashboard');
        } else {
          setError("Could not find valid data rows in the file.");
        }
      } catch (err) { 
        setError("Error parsing file. Please ensure it is a valid CSV or Excel file.");
      }
    };

    if (isExcel) reader.readAsBinaryString(file);
    else reader.readAsText(file);
  };

  const getMetrics = useCallback((data: RawDataRow[]): MetricsResult => {
    if (!data.length) return { intents: [], entityAcc: 0, avgF1: 0, avgRecall: 0, avgPrecision: 0, incorrectEntities: 0 };
    
    const intentList = Array.from(new Set(data.map(item => item.actual_intent).filter(Boolean))) as string[];
    let totalEntityCorrect = 0;
    let incorrectEntitiesCount = 0;
    
    const intentMetrics = intentList.map(intent => {
      let tp = 0, fn = 0, fp = 0, tn = 0;
      data.forEach(item => {
        const actual = item.actual_intent;
        const predicted = item.predicted_intent;
        if (actual === intent && predicted === intent) tp++;
        else if (actual === intent && predicted !== intent) fn++;
        else if (actual !== intent && predicted === intent) fp++;
        else if (actual !== intent && predicted !== intent) tn++;
      });
      const recall = tp / (tp + fn) || 0;
      const precision = tp / (tp + fp) || 0;
      const f1 = (2 * precision * recall) / (precision + recall) || 0;
      return { intent, tp, fn, fp, tn, recall, precision, f1 };
    });

    data.forEach(item => {
      if (isRowEntityCorrect(item)) totalEntityCorrect++;
      else incorrectEntitiesCount++;
    });

    return { 
      intents: intentMetrics, 
      entityAcc: (totalEntityCorrect / data.length || 0), 
      avgF1: intentMetrics.reduce((a, b) => a + b.f1, 0) / (intentMetrics.length || 1), 
      avgRecall: intentMetrics.reduce((a, b) => a + b.recall, 0) / (intentMetrics.length || 1), 
      avgPrecision: intentMetrics.reduce((a, b) => a + b.precision, 0) / (intentMetrics.length || 1), 
      incorrectEntities: incorrectEntitiesCount 
    };
  }, [isRowEntityCorrect]);

  const analysis = useMemo<AnalysisResult>(() => {
    const hasOosColumn = rawData.some(d => d.oos_flag !== undefined && d.oos_flag !== '');
    
    const inS = rawData.filter(d => {
      if (!hasOosColumn) return true;
      const val = String(d.oos_flag ?? '').toLowerCase();
      return val === '0' || val === '' || val.includes('in');
    });
    const outS = rawData.filter(d => {
      if (!hasOosColumn) return false;
      const val = String(d.oos_flag ?? '').toLowerCase();
      return val === '1' || val.includes('out');
    });
    
    const inM = getMetrics(inS);
    const outM = getMetrics(outS);

    return { 
      inS, outS, inM, outM, 
      isSampleCountOk: hasOosColumn ? outS.length >= inS.length : true, 
      isModelPassed: inM.avgF1 >= ACCEPT_THRESHOLD && 
                     (outS.length === 0 || outM.avgF1 >= ACCEPT_THRESHOLD) && 
                     inM.entityAcc >= ACCEPT_THRESHOLD &&
                     (outS.length === 0 || outM.entityAcc >= ACCEPT_THRESHOLD)
    };
  }, [rawData, getMetrics]);

  const traceData = useMemo(() => {
    let filtered = rawData.filter(d => {
      const entCorrect = isRowEntityCorrect(d);
      
      if (filterType === 'intent_mismatch') return d.actual_intent !== d.predicted_intent;
      if (filterType === 'entity_mismatch') return !entCorrect;
      return true;
    });
    if (sortConfig.key) {
      filtered.sort((a, b) => {
        const aVal = String(a[sortConfig.key!] || '');
        const bVal = String(b[sortConfig.key!] || '');
        return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      });
    }
    return filtered;
  }, [rawData, filterType, sortConfig, isRowEntityCorrect]);

  const toggleSort = (key: keyof RawDataRow) => {
    setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc' }));
  };

  const handleExport = () => {
    if (!window.XLSX || !rawData.length) return;
    const wb = window.XLSX.utils.book_new();
    const knobsReport = [
      ["OMR AUDIT REPORT"], ["Generated", new Date().toLocaleString()], [],
      ["METRIC", "VALUE", "THRESHOLD", "STATUS"],
      ["In-Sample F1", analysis.inM.avgF1.toFixed(4), String(ACCEPT_THRESHOLD), analysis.inM.avgF1 >= ACCEPT_THRESHOLD ? "PASS" : "FAIL"],
      ["Out-Sample F1", analysis.outM.avgF1.toFixed(4), String(ACCEPT_THRESHOLD), analysis.outM.avgF1 >= ACCEPT_THRESHOLD ? "PASS" : "FAIL"],
      ["In-Sample Entity Acc", analysis.inM.entityAcc.toFixed(4), String(ACCEPT_THRESHOLD), analysis.inM.entityAcc >= ACCEPT_THRESHOLD ? "PASS" : "FAIL"],
      ["Out-Sample Entity Acc", analysis.outM.entityAcc.toFixed(4), String(ACCEPT_THRESHOLD), analysis.outM.entityAcc >= ACCEPT_THRESHOLD ? "PASS" : "FAIL"]
    ];
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(knobsReport), "Audit Report");
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(rawData), "Raw Trace");
    window.XLSX.writeFile(wb, \`Rasa_OMR_Audit_${new Date().toISOString().split('T')[0]}.xlsx\`);
  };

  return (
    <div className="flex h-screen bg-[#fafafa] font-sans antialiased text-slate-900 overflow-hidden">
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
        <div className="p-6">
          <div className="flex items-center gap-2.5 mb-8">
            <div className="w-8 h-8 bg-slate-950 rounded-lg flex items-center justify-center text-white">
              <BrainCircuit size={18} />
            </div>
            <h1 className="text-sm font-bold tracking-tight">OMR Analytics</h1>
          </div>
          <nav className="space-y-1">
            {[
              { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
              { id: 'insample', label: 'In-Sample Pivot', icon: CheckCircle2 },
              { id: 'outsample', label: 'Out-Sample Pivot', icon: AlertCircle },
              { id: 'raw', label: 'Trace Logs', icon: FileText }
            ].map(item => (
              <button 
                key={item.id} 
                onClick={() => setActiveTab(item.id)} 
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-xs font-semibold transition-all",
                  activeTab === item.id ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                )}
              >
                <item.icon size={14} /> {item.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="mt-auto p-4 border-t border-slate-100">
          {!isLibReady && (
            <div className="mb-4 px-3 py-2 bg-blue-50 text-blue-700 rounded-lg text-[10px] flex items-center gap-2 font-bold animate-pulse">
              <Loader2 size={12} className="animate-spin" />
              Loading Excel Library...
            </div>
          )}
          {error && (
            <div className="mb-4 px-3 py-2 bg-red-50 text-red-700 rounded-lg text-[10px] flex items-center gap-2 font-bold leading-tight">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
          <div 
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }} 
            onDragLeave={() => setIsDragging(false)} 
            onDrop={e => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0]); }} 
            className={cn(
              "p-4 rounded-lg border border-dashed text-center cursor-pointer transition-all",
              isDragging ? "bg-slate-50 border-slate-900 scale-[1.02]" : "bg-white border-slate-200 hover:border-slate-400"
            )} 
            onClick={() => (document.querySelector('#fileInput') as HTMLInputElement)?.click()}
          >
            <input 
              type="file" 
              id="fileInput" 
              className="hidden" 
              accept=".csv, .xlsx, .xls" 
              onChange={e => e.target.files?.[0] && processFile(e.target.files[0])} 
            />
            <Upload size={16} className="mx-auto mb-2 text-slate-400" />
            <p className="text-[10px] font-bold text-slate-600">Drop Audit File</p>
          </div>
          {fileName && <p className="text-[9px] text-slate-400 mt-2 truncate font-mono text-center">{fileName}</p>}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-slate-200 bg-white px-8 flex items-center justify-between sticky top-0 z-20 flex-shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-bold text-slate-900">
              {activeTab === 'dashboard' ? 'Model Integrity Dashboard' : activeTab.toUpperCase()}
            </h2>
            {rawData.length > 0 && (
              <div className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                analysis.isModelPassed ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
              )}>
                {analysis.isModelPassed ? <ShieldCheck size={12} /> : <XCircle size={12} />} 
                {analysis.isModelPassed ? "Model Accepted" : "Model Rejected"}
              </div>
            )}
          </div>
          <div className="flex gap-3">
            {rawData.length > 0 && (
              <button 
                onClick={handleExport} 
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 text-white rounded-md text-[11px] font-bold hover:bg-slate-800 shadow-sm transition-all"
              >
                <Download size={14} /> Export Report
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="p-8 max-w-[1400px] mx-auto w-full">
            {!rawData.length ? (
              <div className="h-[70vh] flex flex-col items-center justify-center">
                <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mb-6 border border-slate-100">
                  <FileSpreadsheet size={32} className="text-slate-300" />
                </div>
                <h3 className="text-lg font-bold mb-2">Initialize Model Audit</h3>
                <p className="text-sm text-slate-500 text-center max-w-xs mb-8">
                  Upload evaluation results to verify accuracy thresholds.
                </p>
                <button 
                  onClick={() => (document.querySelector('#fileInput') as HTMLInputElement)?.click()} 
                  className="px-6 py-2.5 bg-slate-900 text-white rounded-lg text-xs font-bold shadow-md"
                >
                  Choose Data Source
                </button>
              </div>
            ) : (
              <div className="space-y-8 pb-10">
                {activeTab === 'dashboard' && (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <StatCard 
                        title="In-Sample F1" 
                        value={analysis.inM.avgF1} 
                        subtext={\`${analysis.inS.length} records\`} 
                        status={analysis.inM.avgF1 >= ACCEPT_THRESHOLD} 
                        icon={CheckCircle2} 
                      />
                      <StatCard 
                        title="Out-Sample F1" 
                        value={analysis.outM.avgF1} 
                        subtext={\`${analysis.outS.length} records\`} 
                        status={analysis.outS.length === 0 || analysis.outM.avgF1 >= ACCEPT_THRESHOLD} 
                        icon={AlertCircle} 
                      />
                      <StatCard 
                        title="In-Sample Entity" 
                        value={analysis.inM.entityAcc || 0} 
                        subtext="Accuracy" 
                        status={analysis.inM.entityAcc >= ACCEPT_THRESHOLD} 
                        icon={Scale} 
                      />
                      <StatCard 
                        title="Out-Sample Entity" 
                        value={analysis.outM.entityAcc || 0} 
                        subtext="Accuracy" 
                        status={analysis.outS.length === 0 || analysis.outM.entityAcc >= ACCEPT_THRESHOLD} 
                        icon={Scale} 
                      />
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                      <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 h-80">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={analysis.inM.intents.slice(0, 10)}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                            <XAxis dataKey="intent" fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                            <YAxis domain={[0, 1]} fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                            <Tooltip />
                            <Bar dataKey="f1" fill="#0f172a" radius={[2, 2, 0, 0]} barSize={24} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="bg-white p-6 rounded-xl border border-slate-200 flex flex-col items-center">
                        <div className="h-48 w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie 
                                data={[{ name: 'In', value: analysis.inS.length }, { name: 'Out', value: analysis.outS.length }]} 
                                innerRadius={50} 
                                outerRadius={70} 
                                paddingAngle={4} 
                                dataKey="value"
                              >
                                <Cell fill="#cbd5e1" />
                                <Cell fill="#0f172a" />
                              </Pie>
                              <Tooltip />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <p className="text-[10px] text-slate-400 italic text-center mt-4">
                          {analysis.isSampleCountOk ? "✓ Coverage criteria met" : "! Insufficient Out-Sample volume"}
                        </p>
                      </div>
                    </div>
                  </>
                )}

                {(activeTab === 'insample' || activeTab === 'outsample') && (
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                    <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                      <h4 className="text-[11px] font-bold uppercase text-slate-500 tracking-wider">
                        {activeTab === 'insample' ? 'In-Sample Intent Metrics' : 'Out-Sample Robustness Metrics'}
                      </h4>
                      <div className="flex gap-4">
                        <div className="text-right">
                          <p className="text-[10px] text-slate-400 uppercase font-bold">Avg F1</p>
                          <p className="text-sm font-bold">{(activeTab === 'insample' ? analysis.inM.avgF1 : analysis.outM.avgF1).toFixed(4)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] text-slate-400 uppercase font-bold">Entity Acc</p>
                          <p className="text-sm font-bold">{(activeTab === 'insample' ? analysis.inM.entityAcc : analysis.outM.entityAcc).toFixed(4)}</p>
                        </div>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead className="bg-white border-b border-slate-100">
                          <tr>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Intent</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">TP</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">FN</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">FP</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Recall</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Precision</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-900 uppercase tracking-widest">F1 Score</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {(activeTab === 'insample' ? analysis.inM.intents : analysis.outM.intents).map((m, i) => (
                            <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-3.5 text-xs font-bold text-slate-700">{m.intent}</td>
                              <td className="px-6 py-3.5 text-xs text-slate-500 text-center">{m.tp}</td>
                              <td className="px-6 py-3.5 text-xs text-slate-500 text-center">{m.fn}</td>
                              <td className="px-6 py-3.5 text-xs text-slate-500 text-center">{m.fp}</td>
                              <td className="px-6 py-3.5 text-xs font-medium text-slate-600 font-mono">{m.recall.toFixed(4)}</td>
                              <td className="px-6 py-3.5 text-xs font-medium text-slate-600 font-mono">{m.precision.toFixed(4)}</td>
                              <td className={cn(
                                "px-6 py-3.5 text-xs font-bold font-mono", 
                                m.f1 >= PASS_THRESHOLD ? "text-emerald-600" : m.f1 >= ACCEPT_THRESHOLD ? "text-slate-900" : "text-red-500"
                              )}>
                                {m.f1.toFixed(4)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'raw' && (
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col h-[calc(100vh-220px)]">
                    <div className="px-6 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 flex-shrink-0">
                      <div className="flex gap-2">
                        {['all', 'intent_mismatch', 'entity_mismatch'].map(type => (
                          <button 
                            key={type} 
                            onClick={() => setFilterType(type)} 
                            className={cn(
                              "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight transition-all", 
                              filterType === type ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-500 hover:border-slate-300"
                            )}
                          >
                            {type.replace('_', ' ')}
                          </button>
                        ))}
                      </div>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{traceData.length} records in view</span>
                    </div>
                    
                    <div className="overflow-auto flex-1 relative scroll-smooth">
                      <table className="w-full text-left border-collapse table-fixed min-w-[800px]">
                        <thead className="bg-white sticky top-0 z-20 shadow-sm">
                          <tr>
                            {['text', 'actual_intent', 'predicted_intent', 'actual_entities', 'predicted_entities'].map(col => (
                              <th 
                                key={col} 
                                onClick={() => toggleSort(col as keyof RawDataRow)} 
                                className="px-6 py-4 text-[9px] font-bold text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-900 group"
                              >
                                <div className="flex items-center gap-2">
                                  {col.replace('_', ' ')}
                                  <div className="flex flex-col">
                                    <ChevronUp size={10} className={cn(sortConfig.key === col && sortConfig.direction === 'asc' ? "text-slate-900" : "text-slate-200")} />
                                    <ChevronDown size={10} className={cn("-mt-1", sortConfig.key === col && sortConfig.direction === 'desc' ? "text-slate-900" : "text-slate-200")} />
                                  </div>
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {traceData.map((row, i) => {
                            const entRes = compareEntities(row.actual_entities, row.predicted_entities);
                            const intentMismatch = row.actual_intent !== row.predicted_intent;
                            const isEntityCorrect = isRowEntityCorrect(row);
                            const isFail = intentMismatch || !isEntityCorrect;
                            
                            const displayEnt = (val: any) => {
                              if (!val || val === '[]' || (Array.isArray(val) && val.length === 0)) return '-';
                              return String(val);
                            };
                            
                            return (
                              <React.Fragment key={i}>
                                <tr className={cn("transition-all duration-200", isFail ? "bg-slate-50/40" : "hover:bg-slate-50/80")}>
                                  <td className="px-6 py-4 text-xs font-medium text-slate-700 leading-relaxed">{row.text || '-'}</td>
                                  <td className="px-6 py-4">
                                    <span className="text-[10px] px-2 py-1 rounded bg-slate-100 text-slate-600 font-bold border border-slate-200/50">
                                      {row.actual_intent || '-'}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-2">
                                      <span className={cn(
                                        "text-[10px] px-2 py-1 rounded font-bold border", 
                                        intentMismatch ? "bg-red-50 text-red-700 border-red-100" : "bg-emerald-50 text-emerald-700 border-emerald-100"
                                      )}>
                                        {row.predicted_intent || '-'}
                                      </span>
                                      {intentMismatch && <Info size={12} className="text-red-400 animate-pulse" />}
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-[10px] text-slate-400 font-mono truncate">{displayEnt(row.actual_entities)}</td>
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-2">
                                      <span className={cn(
                                        "text-[10px] px-2 py-1 rounded font-bold border", 
                                        !isEntityCorrect ? "bg-amber-50 text-amber-700 border-amber-100" : "bg-slate-50 text-slate-400 border-slate-100"
                                      )}>
                                        {displayEnt(row.predicted_entities)}
                                      </span>
                                      {!isEntityCorrect && <AlertCircle size={12} className="text-amber-500" />}
                                    </div>
                                  </td>
                                </tr>
                                {isFail && (
                                  <tr className="bg-white">
                                    <td colSpan={5} className="px-8 pb-4">
                                      <div className="bg-white border border-slate-100 rounded-xl p-4 shadow-sm space-y-3">
                                        {intentMismatch && (
                                          <p className="text-[11px] font-bold text-slate-600">
                                            Classification Failure: Expected <span className="text-slate-900">"{row.actual_intent}"</span> but model predicted <span className="text-red-600">"{row.predicted_intent}"</span>
                                          </p>
                                        )}
                                        {!isEntityCorrect && (
                                          <div className="flex flex-wrap gap-2">
                                            {entRes.missing.map((m, j) => (
                                              <span key={j} className="flex items-center gap-1.5 text-[10px] bg-red-50 text-red-700 px-2 py-1 rounded border border-red-100 font-bold">
                                                <MinusCircle size={12} /> Missing: {m}
                                              </span>
                                            ))}
                                            {entRes.extra.map((e, j) => (
                                              <span key={j} className="flex items-center gap-1.5 text-[10px] bg-amber-50 text-amber-700 px-2 py-1 rounded border border-amber-100 font-bold">
                                                <PlusCircle size={12} /> Extra: {e}
                                              </span>
                                            ))}
                                            {entRes.match && row.entity_crrct_flag !== undefined && (
                                              <span className="text-[10px] text-red-500 italic font-bold">
                                                ! Manually flagged as incorrect
                                              </span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;`;

  return (
    <div className="flex h-screen bg-[#fafafa] font-sans antialiased text-slate-900 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
        <div className="p-6">
          <div className="flex items-center gap-2.5 mb-8">
            <div className="w-8 h-8 bg-slate-950 rounded-lg flex items-center justify-center text-white">
              <BrainCircuit size={18} />
            </div>
            <h1 className="text-sm font-bold tracking-tight">OMR Analytics</h1>
          </div>

          <nav className="space-y-1">
            {[
              { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
              { id: 'insample', label: 'In-Sample Pivot', icon: CheckCircle2 },
              { id: 'outsample', label: 'Out-Sample Pivot', icon: AlertCircle },
              { id: 'raw', label: 'Trace Logs', icon: FileText },
            ].map(item => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-xs font-semibold transition-all",
                  activeTab === item.id ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                )}
              >
                <item.icon size={14} /> {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="mt-auto p-4 border-t border-slate-100">
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0]);
            }}
            className={cn(
              "p-4 rounded-lg border border-dashed text-center cursor-pointer transition-all",
              isDragging ? "bg-slate-50 border-slate-900 scale-[1.02]" : "bg-white border-slate-200 hover:border-slate-400"
            )}
            onClick={() => (document.querySelector('#fileInput') as HTMLInputElement)?.click()}
          >
            <input
              type="file"
              id="fileInput"
              className="hidden"
              accept=".csv, .xlsx, .xls"
              onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])}
            />
            <Upload size={16} className="mx-auto mb-2 text-slate-400" />
            <p className="text-[10px] font-bold text-slate-600">Drop Audit File</p>
          </div>
          {fileName && <p className="text-[9px] text-slate-400 mt-2 truncate font-mono text-center">{fileName}</p>}
        </div>
      </aside>

      {/* Main Container */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-slate-200 bg-white px-8 flex items-center justify-between sticky top-0 z-20 flex-shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-bold text-slate-900">
              {activeTab === 'dashboard' ? 'Model Integrity Dashboard' : activeTab.toUpperCase().replace('_', ' ')}
            </h2>
            {rawData.length > 0 && (
              <div className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                analysis.isModelPassed ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
              )}>
                {analysis.isModelPassed ? <ShieldCheck size={12} /> : <XCircle size={12} />}
                {analysis.isModelPassed ? "Model Accepted" : "Model Rejected"}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setShowSourceCode(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 text-slate-700 rounded-md text-[11px] font-bold hover:bg-slate-200 transition-all"
            >
              <FileText size={14} /> Source Code
            </button>
            {rawData.length > 0 && (
              <button
                onClick={handleExport}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 text-white rounded-md text-[11px] font-bold hover:bg-slate-800 transition-all shadow-sm"
              >
                <Download size={14} /> Export Report
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="p-8 max-w-[1400px] mx-auto w-full">
            {!rawData.length ? (
              <div className="h-[70vh] flex flex-col items-center justify-center">
                <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mb-6 border border-slate-100">
                  <FileSpreadsheet size={32} className="text-slate-300" />
                </div>
                <h3 className="text-lg font-bold mb-2">Initialize Model Audit</h3>
                <p className="text-sm text-slate-500 text-center max-w-xs mb-8 font-medium leading-relaxed">
                  Upload your Rasa evaluation results to verify accuracy thresholds and sample distributions.
                </p>
                <button
                  onClick={() => (document.querySelector('#fileInput') as HTMLInputElement)?.click()}
                  className="px-6 py-2.5 bg-slate-900 text-white rounded-lg text-xs font-bold shadow-md"
                >
                  Choose Data Source
                </button>
              </div>
            ) : (
              <div className="space-y-8 pb-10">
                {activeTab === 'dashboard' && (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <StatCard title="In-Sample F1" value={analysis.inM.avgF1} subtext={`${analysis.inS.length} records`} status={analysis.inM.avgF1 >= ACCEPT_THRESHOLD} icon={CheckCircle2} />
                      <StatCard title="Out-Sample F1" value={analysis.outM.avgF1} subtext={`${analysis.outS.length} records`} status={analysis.outM.avgF1 >= ACCEPT_THRESHOLD} icon={AlertCircle} />
                      <StatCard title="In-Sample Entities" value={analysis.inM.entityAcc} subtext="Extraction accuracy" status={analysis.inM.entityAcc >= ACCEPT_THRESHOLD} icon={Scale} />
                      <StatCard title="Data Sufficiency" value={analysis.isSampleCountOk ? "Verified" : "Fail"} subtext={`${analysis.outS.length} vs ${analysis.inS.length}`} status={analysis.isSampleCountOk} icon={ArrowUpRight} />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                      <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200">
                        <div className="flex justify-between items-center mb-8">
                          <h4 className="text-xs font-bold uppercase text-slate-400 tracking-widest">Top Intent Performance</h4>
                        </div>
                        <div className="h-72">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={analysis.inM.intents.slice(0, 10)}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                              <XAxis dataKey="intent" fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                              <YAxis domain={[0, 1]} fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                              <Tooltip contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontSize: '10px'}} />
                              <Bar dataKey="f1" fill="#0f172a" radius={[2, 2, 0, 0]} barSize={24} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      <div className="bg-white p-6 rounded-xl border border-slate-200">
                        <h4 className="text-xs font-bold uppercase text-slate-400 tracking-widest mb-8">Coverage Status</h4>
                        <div className="flex flex-col items-center">
                          <div className="h-48 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <PieChart>
                                <Pie data={[{ name: 'In', value: analysis.inS.length }, { name: 'Out', value: analysis.outS.length }]} innerRadius={50} outerRadius={70} paddingAngle={4} dataKey="value">
                                  <Cell fill="#cbd5e1" /><Cell fill="#0f172a" />
                                </Pie>
                                <Tooltip />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                          <p className="text-[10px] text-slate-400 italic text-center mt-4">
                            {analysis.isSampleCountOk ? "✓ Coverage criteria met" : "! Insufficient Out-Sample volume"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {(activeTab === 'insample' || activeTab === 'outsample') && (
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                    <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                      <h4 className="text-[11px] font-bold uppercase text-slate-500 tracking-wider">
                        {activeTab === 'insample' ? 'In-Sample Intent Metrics' : 'Out-Sample Robustness Metrics'}
                      </h4>
                      <div className="flex gap-4">
                        <div className="text-right">
                          <p className="text-[10px] text-slate-400 uppercase font-bold">Avg F1</p>
                          <p className="text-sm font-bold">{(activeTab === 'insample' ? analysis.inM.avgF1 : analysis.outM.avgF1).toFixed(4)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] text-slate-400 uppercase font-bold">Entity Acc</p>
                          <p className="text-sm font-bold">{(activeTab === 'insample' ? analysis.inM.entityAcc : analysis.outM.entityAcc).toFixed(4)}</p>
                        </div>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead className="bg-white border-b border-slate-100">
                          <tr>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Intent</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">TP</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">FN</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">FP</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Recall</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Precision</th>
                            <th className="px-6 py-3 text-[10px] font-bold text-slate-900 uppercase tracking-widest">F1 Score</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {(activeTab === 'insample' ? analysis.inM.intents : analysis.outM.intents).map((m, i) => (
                            <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-3.5 text-xs font-bold text-slate-700">{m.intent}</td>
                              <td className="px-6 py-3.5 text-xs text-slate-500 text-center">{m.tp}</td>
                              <td className="px-6 py-3.5 text-xs text-slate-500 text-center">{m.fn}</td>
                              <td className="px-6 py-3.5 text-xs text-slate-500 text-center">{m.fp}</td>
                              <td className="px-6 py-3.5 text-xs font-medium text-slate-600 font-mono">{m.recall.toFixed(4)}</td>
                              <td className="px-6 py-3.5 text-xs font-medium text-slate-600 font-mono">{m.precision.toFixed(4)}</td>
                              <td className={cn("px-6 py-3.5 text-xs font-bold font-mono", m.f1 >= PASS_THRESHOLD ? "text-emerald-600" : m.f1 >= ACCEPT_THRESHOLD ? "text-slate-900" : "text-red-500")}>{m.f1.toFixed(4)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'raw' && (
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm flex flex-col h-[calc(100vh-220px)]">
                    <div className="px-6 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 flex-shrink-0">
                      <div className="flex gap-2">
                        {['all', 'intent_mismatch', 'entity_mismatch'].map(type => (
                          <button
                            key={type}
                            onClick={() => setFilterType(type)}
                            className={cn(
                              "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight transition-all",
                              filterType === type ? "bg-slate-900 text-white shadow-sm" : "bg-white border border-slate-200 text-slate-500 hover:border-slate-300"
                            )}
                          >
                            {type.replace('_', ' ')}
                          </button>
                        ))}
                      </div>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{traceData.length} records in view</span>
                    </div>

                    <div className="overflow-auto flex-1 relative scroll-smooth">
                      <table className="w-full text-left border-collapse table-fixed min-w-[800px]">
                        <thead className="bg-white sticky top-0 z-20 shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
                          <tr>
                            {[
                              { label: 'Utterance Text', key: 'text' as keyof RawDataRow },
                              { label: 'Actual Intent', key: 'actual_intent' as keyof RawDataRow },
                              { label: 'Predicted Intent', key: 'predicted_intent' as keyof RawDataRow },
                              { label: 'Actual Entities', key: 'actual_entities' as keyof RawDataRow },
                              { label: 'Predicted Entities', key: 'predicted_entities' as keyof RawDataRow }
                            ].map(col => (
                              <th
                                key={col.key as string}
                                onClick={() => toggleSort(col.key)}
                                className="px-6 py-4 text-[9px] font-bold text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-900 transition-colors group"
                              >
                                <div className="flex items-center gap-2">
                                  {col.label}
                                  <div className="flex flex-col">
                                    <ChevronUp size={10} className={cn("transition-opacity", sortConfig.key === col.key && sortConfig.direction === 'asc' ? "text-slate-900" : "text-slate-200 group-hover:text-slate-300")} />
                                    <ChevronDown size={10} className={cn("-mt-1 transition-opacity", sortConfig.key === col.key && sortConfig.direction === 'desc' ? "text-slate-900" : "text-slate-200 group-hover:text-slate-300")} />
                                  </div>
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {traceData.map((row, i) => {
                            const entRes = compareEntities(row.actual_entities, row.predicted_entities);
                            const intentMismatch = row.actual_intent !== row.predicted_intent;
                            const isFail = intentMismatch || !entRes.match;

                            return (
                              <React.Fragment key={i}>
                                <tr className={cn(
                                  "transition-all duration-200",
                                  isFail ? "bg-slate-50/40" : "hover:bg-slate-50/80"
                                )}>
                                  <td className="px-6 py-4 text-xs font-medium text-slate-700 leading-relaxed">{row.text || '-'}</td>
                                  <td className="px-6 py-4">
                                    <span className="text-[10px] px-2 py-1 rounded bg-slate-100 text-slate-600 font-bold border border-slate-200/50">{row.actual_intent || '-'}</span>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-2">
                                      <span className={cn(
                                        "text-[10px] px-2 py-1 rounded font-bold border",
                                        intentMismatch ? "bg-red-50 text-red-700 border-red-100 shadow-sm" : "bg-emerald-50 text-emerald-700 border-emerald-100 shadow-sm"
                                      )}>
                                        {row.predicted_intent || '-'}
                                      </span>
                                      {intentMismatch && <Info size={12} className="text-red-400 animate-pulse" />}
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-[10px] text-slate-400 font-mono truncate hover:whitespace-normal transition-all">
                                    {row.actual_entities ? String(row.actual_entities) : '-'}
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-2">
                                      <span className={cn(
                                        "text-[10px] px-2 py-1 rounded font-bold border",
                                        !entRes.match ? "bg-amber-50 text-amber-700 border-amber-100" : "bg-slate-50 text-slate-400 border-slate-100"
                                      )}>
                                        {row.predicted_entities ? (String(row.predicted_entities).length > 20 ? String(row.predicted_entities).substring(0, 20) + '...' : String(row.predicted_entities)) : '-'}
                                      </span>
                                      {!entRes.match && <AlertCircle size={12} className="text-amber-500" />}
                                    </div>
                                  </td>
                                </tr>
                                {isFail && (
                                  <tr className="bg-white">
                                    <td colSpan={5} className="px-8 pb-4">
                                      <div className="bg-white border border-slate-100 rounded-xl p-4 shadow-sm space-y-3">
                                        {intentMismatch && (
                                          <div className="flex items-center gap-3">
                                            <div className="p-1 bg-red-100 text-red-600 rounded">
                                              <XCircle size={14} />
                                            </div>
                                            <p className="text-[11px] font-bold text-slate-600">
                                              Classification Failure: Expected <span className="text-slate-900">"{row.actual_intent}"</span> but model predicted <span className="text-red-600">"{row.predicted_intent}"</span>
                                            </p>
                                          </div>
                                        )}
                                        {!entRes.match && (
                                          <div className="flex items-start gap-3">
                                            <div className="p-1 mt-0.5 bg-amber-100 text-amber-600 rounded">
                                              <Scale size={14} />
                                            </div>
                                            <div className="flex-1">
                                              <p className="text-[11px] font-bold text-slate-600 mb-2">Entity Extraction Failures:</p>
                                              <div className="flex flex-wrap gap-2">
                                                {entRes.missing.map((m, j) => (
                                                  <span key={j} className="flex items-center gap-1.5 text-[10px] bg-red-50 text-red-700 px-2 py-1 rounded-md border border-red-100 font-bold">
                                                    <MinusCircle size={12} /> Missing: {m}
                                                  </span>
                                                ))}
                                                {entRes.extra.map((e, j) => (
                                                  <span key={j} className="flex items-center gap-1.5 text-[10px] bg-amber-50 text-amber-700 px-2 py-1 rounded-md border border-amber-100 font-bold">
                                                    <PlusCircle size={12} /> Extra: {e}
                                                  </span>
                                                ))}
                                              </div>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Source Code Modal */}
      {showSourceCode && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-5xl max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center px-6 py-4 border-b border-slate-200">
              <h3 className="text-sm font-bold text-slate-900">App.tsx Full Source Code</h3>
              <button
                onClick={() => setShowSourceCode(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <XCircle size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-slate-950 p-4">
              <pre
                className="text-xs font-mono text-slate-100 leading-relaxed"
                id="sourceCodeContent"
              >{sourceCodeDisplay}</pre>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex gap-2 justify-end">
              <button
                onClick={() => {
                  const codeContent = document.getElementById('sourceCodeContent')?.textContent;
                  if (codeContent) {
                    navigator.clipboard.writeText(codeContent);
                    alert('Full App.tsx source code copied to clipboard!');
                  }
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition-all flex items-center gap-2"
              >
                <FileText size={14} /> Copy All Code
              </button>
              <button
                onClick={() => setShowSourceCode(false)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-800 transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
