
using System;
using System.Text;

class Program {
    static Program() {
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;
    }
    static int _var_nbr, _var_double;
static void Main() {
    Console.WriteLine("entrez un nbr : ");
    
                        Console.Write("​"); 
                        _var_nbr = (dynamic)Convert.ChangeType(Console.ReadLine(), _var_nbr.GetType());
                        Console.WriteLine(_var_nbr);
    _var_double = _var_nbr * 2;
    Console.WriteLine("le double est : "  + "" +  _var_double);
}

    public static int Addition(params object[] obj)
    {
        int somme = 0;
        foreach (var objInstance in obj)
        {
            if (objInstance is not int)
            {
                throw new Exception("Une valeur non entière a été détectée dans l'addition");
            }
            somme += (int)objInstance;
        }
        return somme;
    }
}