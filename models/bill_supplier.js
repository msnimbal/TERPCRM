"use strict";
/**
 * Module dependencies.
 */
var mongoose = require('mongoose'),
        Schema = mongoose.Schema,
        timestamps = require('mongoose-timestamp');

var DataTable = require('mongoose-datatable');

DataTable.configure({
    verbose: false,
    debug: false
});
mongoose.plugin(DataTable.init);

var Dict = INCLUDE('dict');


var setPrice = function (value) {
    return MODULE('utils').setPrice(value);
};

/**
 * Article Schema
 */
var billSupplierSchema = new Schema({
    ref: {type: String, unique: true},
    type: {type: String, default: 'INVOICE_STANDARD'},
    Status: {type: String, default: 'DRAFT'},
    isremoved: Boolean,
    //title: {//For internal use only
    //    ref: String,
    //    autoGenerated: {type: Boolean, default: false}, //For automatic process generated bills
    //},
    cond_reglement_code: {type: String, default: '30D'},
    mode_reglement_code: {type: String, default: 'CHQ'},
    supplier: {
        id: {type: Schema.Types.ObjectId, ref: 'societe'},
        name: String,
        isNameModified: {type: Boolean}
    },
    address: {type: String, default: ""},
    zip: {type: String, default: ""},
    town: {type: String, default: ""},
    country_id: {type: String, default: 'FR'},
    state_id: Number,
    contacts: [{
            type: Schema.Types.ObjectId,
            ref: 'contact'
        }],
    ref_supplier: {type: String},
    pieceAccounting: Number,
    libelleAccounting: String,
    imported: {type: Boolean, default: false}, //imported in accounting
    journalId: [Schema.Types.ObjectId], // Id transactions for accounting
    datec: {type: Date, default: new Date},
    dater: {type: Date}, // Date echeance
    dateOf: {type: Date}, // Periode de facturation du
    dateTo: {type: Date}, // au
    notes: [{
            author: {
                id: {type: String, ref: 'User'},
                name: String
            },
            datec: Date,
            note: String
        }],
    discount: {
        percent: {type: Number, default: 0},
        value: {type: Number, default: 0, set: setPrice} // total remise globale
    },
    correction: {type: Number, default: 0, set: setPrice}, // centimes d'erreur
    total_ht: {type: Number, default: 0, set: setPrice},
    total_tva: [
        {
            tva_tx: Number,
            total: {type: Number, default: 0, set: setPrice}
        }
    ],
    total_ttc: {type: Number, default: 0, set: setPrice},
    total_paid: {type: Number, default: 0, set: setPrice},
    shipping: {
        total_ht: {type: Number, default: 0, set: setPrice},
        tva_tx: {type: Number, default: 20},
        total_tva: {type: Number, default: 0}
    },
    author: {id: String, name: String},
    commercial_id: {id: {type: String}, name: String}, // Buyer
    entity: {type: String},
    orders: [{
            id: Schema.Types.ObjectId,
            ref: String,
            url: String
        }],
    lines: [{
            //pu: Number,
            qty: Number,
            tva_tx: Number,
            pu_ht: Number,
            description: String,
            product_type: String,
            product: {
                id: {type: Schema.Types.ObjectId, ref: "Product"},
                name: {type: String},
                label: String
                        //  family: String
            },
            total_tva: Number,
            total_ttc: Number,
            //total_ht_without_discount: Number,
            //total_ttc_without_discount: Number,
            //total_vat_without_discount: Number,
            total_ht: {type: Number, set: setPrice},
            discount: {type: Number, default: 0}

        }],
    history: [{date: Date, author: {id: String, name: String}, Status: Schema.Types.Mixed}],
    latex: {
        title: String,
        createdAt: {type: Date},
        data: Buffer
    }
}, {
    toObject: {virtuals: true},
    toJSON: {virtuals: true}
});
billSupplierSchema.plugin(timestamps);
var cond_reglement = {};
Dict.dict({dictName: "fk_payment_term", object: true}, function (err, docs) {
    cond_reglement = docs;
});
/**
 * Pre-save hook
 */
billSupplierSchema.pre('save', function (next) {
    var SeqModel = MODEL('Sequence').Schema;
    var EntityModel = MODEL('entity').Schema;
    var self = this;
    this.calculate_date_lim_reglement();

    MODULE('utils').sumTotal(this.lines, this.shipping, this.discount, this.supplier.id, function (err, result) {
        if (err)
            return next(err);

        self.total_ht = result.total_ht;
        self.total_tva = result.total_tva;
        self.total_ttc = result.total_ttc;

        // Apply correction
        self.total_ttc += self.correction;

        if (self.isNew || self.ref.substr(0, 4) == "PROV") {
            EntityModel.findOne({_id: self.entity}, "cptRef", function (err, entity) {
                if (err)
                    return console.log(err);
                if (entity && entity.cptRef) {
                    SeqModel.inc("FF" + entity.cptRef, self.datec, function (seq, idx) {
                        //console.log(seq);
                        self.ref = "FF" + entity.cptRef + seq;
                        //if (!self.pieceAccounting)
                        //    self.pieceAccounting = parseInt(seq);
                        next();
                    });
                } else {
                    SeqModel.inc("FF", self.datec, function (seq, idx) {
                        //console.log(seq);
                        self.ref = "FF" + seq;
                        //if (!self.pieceAccounting)
                        //    self.pieceAccounting = parseInt(seq);
                        next();
                    });
                }
            });
        } else {
            if (self.total_ttc == 0)
                self.Status = "DRAFT";
            next();
        }
    });
});
/**
 * Methods
 */
billSupplierSchema.methods = {
    /**
     * inc - increment bill Number
     *
     * @param {function} callback
     * @api public
     */
    setNumber: function () {
        var self = this;
        if (this.ref.substr(0, 4) == "PROV")
            SeqModel.inc("FF", function (seq) {
                //console.log(seq);
                self.ref = "FF" + seq;
            });
    },
    /**
     * 	Renvoi une date limite de reglement de facture en fonction des
     * 	conditions de reglements de la facture et date de facturation
     *
     * 	@param      string	$cond_reglement   	Condition of payment (code or id) to use. If 0, we use current condition.
     * 	@return     date     			       	Date limite de reglement si ok, <0 si ko
     */
    calculate_date_lim_reglement: function () {
        var data = cond_reglement.values[this.cond_reglement_code];
        var cdr_nbjour = data.nbjour || 0;
        var cdr_fdm = data.fdm;
        var cdr_decalage = data.decalage || 0;
        /* Definition de la date limite */

        // 1 : ajout du nombre de jours
        var datelim = new Date(this.datec);
        datelim.setDate(datelim.getDate() + cdr_nbjour);
        //console.log(cdr_nbjour);

        // 2 : application de la regle "fin de mois"
        if (cdr_fdm) {
            var mois = datelim.getMonth();
            var annee = datelim.getFullYear();
            if (mois === 12) {
                mois = 1;
                annee += 1;
            } else {
                mois += 1;
            }

            // On se deplace au debut du mois suivant, et on retire un jour
            datelim.setHours(0);
            datelim.setMonth(mois);
            datelim.setFullYear(annee);
            datelim.setDate(0);
            //console.log(datelim);
        }

        // 3 : application du decalage
        datelim.setDate(datelim.getDate() + cdr_decalage);
        //console.log(datelim);

        this.dater = datelim;
    }
};
var statusList = {};
Dict.dict({dictName: 'fk_bill_status', object: true}, function (err, doc) {
    if (err) {
        console.log(err);
        return;
    }
    statusList = doc;
});
billSupplierSchema.virtual('status')
        .get(function () {
            var res_status = {};
            var status = this.Status;

            if (status === 'NOT_PAID' && this.dater > new Date()) //Check if late
                status = 'VALIDATE';


            if (status && statusList.values[status].label) {
                //console.log(this);
                res_status.id = status;
                res_status.name = i18n.t("bills:" + statusList.values[status].label);
                //res_status.name = statusList.values[status].label;
                res_status.css = statusList.values[status].cssClass;
            } else { // By default
                res_status.id = status;
                res_status.name = status;
                res_status.css = "";
            }
            return res_status;
        });
exports.Schema = mongoose.model('billSupplier', billSupplierSchema, 'BillSupplier');
exports.name = 'billSupplier';
